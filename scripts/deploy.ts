/**
 * Deploys the VeilPay spending policy contract to a Midnight network.
 *
 * Settings come from the shell environment, falling back to a .env file in the
 * project root. Exported shell variables win over .env.
 *
 * Required:
 *   VEILPAY_WALLET_SEED     hex master seed of a funded wallet
 * Optional:
 *   VEILPAY_NETWORK         preview (default) | preprod
 *   VEILPAY_PROOF_SERVER    proof server URL (default http://127.0.0.1:6300)
 *   VEILPAY_POLICY_VERSION  initial public policy version (default 1)
 *   VEILPAY_BUDGET          initial private budget, never leaves this machine (default 1000)
 *   VEILPAY_SYNC_TIMEOUT_MS wallet sync budget (default 3600000, i.e. 60 minutes)
 *   VEILPAY_SETTLE_TIMEOUT_MS how long to wait for an in-flight funding or dust
 *                           registration transaction to land (default 180000)
 *   VEILPAY_CHECKPOINT_MS   how often to persist sync progress (default 300000);
 *                           0 disables checkpointing
 *   VEILPAY_CHECKPOINT_DIR  where checkpoints are written (default .states)
 *   VEILPAY_SYNC_ONLY       set to 1 to sync and checkpoint, then stop without
 *                           touching the faucet or deploying anything
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Rx from 'rxjs';
import { pipe } from 'effect';
import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  MidnightWalletProvider,
  PreprodTestEnvironment,
  PreviewTestEnvironment,
  createLogger,
  initializeMidnightProviders,
  waitForFunds,
  type EnvironmentConfiguration,
} from '@midnight-ntwrk/testkit-js';
import { Contract } from '../contracts/managed/spending_policy/contract/index.js';
import { createPrivateState, witnesses, type VeilPayPrivateState } from '../src/midnight/witnesses.ts';
import {
  buildCheckpointedWallet,
  DEFAULT_CHECKPOINT_DIRECTORY,
} from './walletCheckpoint.ts';

type SyncProgressLike = {
  readonly isConnected: boolean;
  readonly appliedIndex: bigint;
  readonly highestRelevantWalletIndex: bigint;
};

const PROJECT_ROOT = join(import.meta.dirname, '..');
const PRIVATE_STATE_ID = 'veilpay-spending-policy';
const ZK_CONFIG_PATH = 'contracts/managed/spending_policy';
const NIGHT_TOKEN = unshieldedToken().raw;

// loadEnvFile leaves already-exported variables untouched, so an explicit
// `export` in the shell still overrides whatever .env holds.
const envFile = join(PROJECT_ROOT, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required. Set it in .env (see .env.example) or export it before deploying.`,
    );
  }
  return value;
};

const readBigInt = (name: string, fallback: bigint): bigint => {
  const value = process.env[name];
  return value === undefined ? fallback : BigInt(value);
};

const resolveNetwork = (logger: Parameters<typeof MidnightWalletProvider.build>[0]) => {
  const network = (process.env.VEILPAY_NETWORK ?? 'preview').toLowerCase();
  switch (network) {
    case 'preview':
      return new PreviewTestEnvironment(logger).getEnvironmentConfiguration();
    case 'preprod':
      return new PreprodTestEnvironment(logger).getEnvironmentConfiguration();
    default:
      throw new Error(`Unsupported VEILPAY_NETWORK '${network}'. Use 'preview' or 'preprod'.`);
  }
};

/**
 * Waits until the wallet is fully synced with the network.
 *
 * testkit's own `syncWallet` hardcodes a 90s budget, which a freshly seeded
 * wallet on Preview routinely exceeds while catching up the shielded and dust
 * chains. This mirrors its completion condition but with a configurable budget
 * and readable progress output.
 */
const waitForFullSync = async (
  wallet: MidnightWalletProvider['wallet'],
  logger: ReturnType<typeof createLogger>,
  timeoutMs: number,
  checkpoint: { readonly save: () => Promise<void>; readonly everyMs: number } | null,
): Promise<void> => {
  logger.info('Syncing wallet with the network...');
  logger.info('A fresh seed scans the chain from genesis; expect roughly 20-30 minutes.');
  if (checkpoint) {
    logger.info(
      `Progress is checkpointed every ${Math.round(checkpoint.everyMs / 60_000)} min; ` +
        'an interrupted run resumes rather than restarting.',
    );
  }

  const startedAt = Date.now();
  let lastLoggedAt = 0;
  let lastCheckpointAt = Date.now();
  // Checkpoints are fire-and-forget against a stream that emits many times per
  // second. Without this guard a slow serialization would be re-entered before
  // it finished and the writes would race each other.
  let checkpointInFlight = false;

  /**
   * Persists progress without interrupting the sync.
   *
   * A failed checkpoint is logged and swallowed: it costs the next run some
   * catching up, whereas letting it reject would abort a sync that is otherwise
   * healthy — the opposite of what checkpointing is for.
   */
  const maybeCheckpoint = (now: number): void => {
    if (!checkpoint || checkpointInFlight || now - lastCheckpointAt < checkpoint.everyMs) {
      return;
    }
    checkpointInFlight = true;
    lastCheckpointAt = now;
    void checkpoint
      .save()
      .catch((error: unknown) => {
        logger.warn(
          `Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        checkpointInFlight = false;
      });
  };

  // progress.isStrictlyComplete() is `isConnected && appliedIndex === highestRelevantWalletIndex`,
  // so the wallet has to catch all the way up to the tip before deployment can start.
  const describe = (label: string, progress: SyncProgressLike): string => {
    const target = progress.highestRelevantWalletIndex;
    const applied = progress.appliedIndex;
    if (!progress.isConnected) {
      return `${label}=disconnected`;
    }
    if (target <= 0n) {
      return `${label}=connecting`;
    }
    const percent = Number((applied * 100n) / target);
    return `${label}=${applied}/${target} (${percent}%)`;
  };

  await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.tap((state) => {
        const now = Date.now();
        maybeCheckpoint(now);
        // The wallet emits many times per second; report every 15s instead.
        if (now - lastLoggedAt < 15_000) {
          return;
        }
        lastLoggedAt = now;
        const elapsed = Math.round((now - startedAt) / 1000);
        logger.info(
          `  sync ${elapsed}s: ${describe('shielded', state.shielded.state.progress)} ` +
            `${describe('dust', state.dust.state.progress)} ` +
            `unshielded=${state.unshielded.progress.isStrictlyComplete() ? 'done' : 'catching up'}`,
        );
      }),
      Rx.filter(
        (state) =>
          state.shielded.state.progress.isStrictlyComplete() &&
          state.dust.state.progress.isStrictlyComplete() &&
          state.unshielded.progress.isStrictlyComplete() === true,
      ),
      // Applied after the filter, so this budgets the time to reach a synced
      // state rather than the gap between raw emissions.
      Rx.timeout({
        each: timeoutMs,
        with: () =>
          Rx.throwError(
            () =>
              new Error(
                `Wallet did not finish syncing within ${Math.round(timeoutMs / 60_000)} minutes. ` +
                  'If the progress percentages were still climbing, raise VEILPAY_SYNC_TIMEOUT_MS and retry.',
              ),
          ),
      }),
    ),
  );

  logger.info(`Wallet synced in ${Math.round((Date.now() - startedAt) / 60_000)} min`);
};

const readNightBalance = async (wallet: MidnightWalletProvider['wallet']): Promise<bigint> => {
  const state = await Rx.firstValueFrom(wallet.state());
  return state.unshielded.balances[NIGHT_TOKEN] ?? 0n;
};

/**
 * Waits for the NIGHT balance to become non-zero.
 *
 * Dust registration spends the wallet's NIGHT UTXO and re-creates it as a
 * registered one, so between submitting that transaction and it landing in a
 * block the balance legitimately reads zero. Resolves to 0n on timeout and
 * lets the caller decide that the wallet really is empty.
 */
const waitForNightBalance = async (
  wallet: MidnightWalletProvider['wallet'],
  timeoutMs: number,
): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.map((state): bigint => state.unshielded.balances[NIGHT_TOKEN] ?? 0n),
      Rx.filter((value) => value > 0n),
      Rx.timeout({ each: timeoutMs, with: () => Rx.of(0n) }),
    ),
  );

/**
 * Reads the HTTP status off a faucet failure.
 *
 * testkit talks to the faucet with axios, which is not a direct dependency
 * here, so this duck-types the shape rather than importing it. Only the status
 * is pulled out: an axios error also carries `config.headers`, and letting the
 * whole object reach a log or an error `cause` would print request credentials.
 */
const httpStatus = (error: unknown): number | undefined => {
  const status = (error as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  return typeof status === 'number' ? status : undefined;
};

const main = async (): Promise<void> => {
  const logger = createLogger('veilpay-deploy.log', 'logs');
  const seed = requireEnv('VEILPAY_WALLET_SEED');
  const policyVersion = readBigInt('VEILPAY_POLICY_VERSION', 1n);
  const budget = readBigInt('VEILPAY_BUDGET', 1000n);

  // The proof server runs locally; the remote environments only publish node and indexer URLs.
  const environment: EnvironmentConfiguration = {
    ...resolveNetwork(logger),
    proofServer: process.env.VEILPAY_PROOF_SERVER ?? 'http://127.0.0.1:6300',
  };
  setNetworkId(environment.networkId);

  logger.info(`Deploying to ${environment.networkId} via proof server ${environment.proofServer}`);

  // No log suppression here, unlike the earlier `MidnightWalletProvider.build`
  // path: that one printed the master seed at info level, so it had to be
  // muted. Building the wallet ourselves never touches the seed logging in
  // testkit — `withWallet` only stores what it is handed — and muting would now
  // hide which checkpoint we resumed from, which is the one thing worth seeing.
  const { walletProvider, saveCheckpoint } = await buildCheckpointedWallet(
    logger,
    environment,
    seed,
    process.env.VEILPAY_CHECKPOINT_DIR ?? DEFAULT_CHECKPOINT_DIRECTORY,
  );

  const checkpointMs = Number(process.env.VEILPAY_CHECKPOINT_MS ?? 300_000);
  const checkpoint = checkpointMs > 0 ? { save: saveCheckpoint, everyMs: checkpointMs } : null;

  // Ctrl-C is how both abandoned Preprod attempts ended, and it is what threw
  // their progress away. Save before leaving, and only then hand the signal back
  // to the default behaviour.
  let interrupted = false;
  const onInterrupt = (): void => {
    if (interrupted) return;
    interrupted = true;
    logger.info('Interrupted — saving the wallet checkpoint before exiting...');
    void (checkpoint ? checkpoint.save() : Promise.resolve())
      .catch((error: unknown) => {
        logger.warn(
          `Checkpoint on exit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        // 130 is the conventional status for a process ended by SIGINT.
        process.exit(130);
      });
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  // Drive startup ourselves rather than walletProvider.start(true), so the
  // initial sync gets a realistic time budget.
  const syncTimeoutMs = Number(process.env.VEILPAY_SYNC_TIMEOUT_MS ?? 3_600_000);
  await walletProvider.wallet.start(walletProvider.zswapSecretKeys, walletProvider.dustSecretKey);
  await waitForFullSync(walletProvider.wallet, logger, syncTimeoutMs, checkpoint);
  // The most valuable checkpoint of all: a fully synced wallet, so a failure in
  // funding or deployment below never costs the sync again.
  if (checkpoint) {
    await checkpoint.save().catch((error: unknown) => {
      logger.warn(
        `Post-sync checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  // Syncing is the expensive half and deploying is the irreversible one, so they
  // are separable: sync now, checkpoint, and deploy in a later run that starts
  // from the saved state in seconds rather than hours.
  if (process.env.VEILPAY_SYNC_ONLY === '1') {
    logger.info('VEILPAY_SYNC_ONLY=1 — wallet is synced and checkpointed. Nothing was deployed.');
    console.log('\nWallet synced and checkpointed. Re-run without VEILPAY_SYNC_ONLY to deploy.');
    await walletProvider.stop();
    return;
  }

  // waitForFunds() bundles three steps: read the balance, request from the
  // faucet, register NIGHT for dust generation. Decide the faucet question here
  // instead of leaving it implicit, so a funded wallet never touches it.
  const fundedBefore = await readNightBalance(walletProvider.wallet);
  const needsFaucet = fundedBefore === 0n;
  if (!needsFaucet) {
    logger.info(`Wallet already holds ${fundedBefore} NIGHT; skipping the faucet.`);
  }

  const settleTimeoutMs = Number(process.env.VEILPAY_SETTLE_TIMEOUT_MS ?? 180_000);
  let balance: bigint;
  try {
    balance = await waitForFunds(
      walletProvider.wallet,
      environment,
      needsFaucet,
      walletProvider.unshieldedKeystore,
    );
  } catch (error) {
    // testkit tolerates only HTTP 429, so every other faucet response — notably
    // the 403 the public faucet returns because its captcha cannot be satisfied
    // from a script — arrives here as a raw client error with no useful text.
    const status = needsFaucet ? httpStatus(error) : undefined;
    if (status !== undefined) {
      throw new Error(
        `The ${environment.networkId} faucet rejected the automated request (HTTP ${status}). ` +
          'Its captcha cannot be answered from this script. Fund the wallet address logged ' +
          `above at ${environment.faucet ?? 'the network faucet'} in a browser, then deploy again.`,
      );
    }
    throw error;
  }

  if (balance === 0n) {
    logger.info('NIGHT balance reads zero; waiting for in-flight transactions to settle...');
    balance = await waitForNightBalance(walletProvider.wallet, settleTimeoutMs);
  }
  if (balance === 0n) {
    throw new Error(
      'Wallet holds no NIGHT. Fund it from the network faucet in a browser and deploy again.',
    );
  }
  logger.info(`Wallet NIGHT balance: ${balance}`);

  try {
    const providers = initializeMidnightProviders<'canSpend', VeilPayPrivateState>(walletProvider, environment, {
      privateStateStoreName: PRIVATE_STATE_ID,
      zkConfigPath: ZK_CONFIG_PATH,
    });

    const compiledContract = pipe(
      CompiledContract.make('spending_policy', Contract),
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets(ZK_CONFIG_PATH),
    );

    const deployed = await deployContract(providers, {
      compiledContract,
      args: [policyVersion],
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: createPrivateState(budget),
    });

    // Only the public half of the deployment data is safe to log or persist.
    const { contractAddress, txId, blockHeight } = deployed.deployTxData.public;
    const record = {
      network: environment.networkId,
      contractAddress,
      deploymentTransaction: txId,
      blockHeight,
      policyVersion: policyVersion.toString(),
      deployedAt: new Date().toISOString(),
    };

    const file = `deployment.${environment.networkId}.json`;
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

    logger.info(`Contract address: ${contractAddress}`);
    logger.info(`Deployment transaction: ${txId}`);
    console.log(`\nNetwork: ${record.network}`);
    console.log(`Contract address: ${record.contractAddress}`);
    console.log(`Deployment transaction: ${record.deploymentTransaction}`);
    console.log(`\nWritten to ${file}`);
  } finally {
    await walletProvider.stop();
  }
};

await main();
