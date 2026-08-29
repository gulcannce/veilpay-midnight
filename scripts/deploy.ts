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
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Rx from 'rxjs';
import { pipe } from 'effect';
import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
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

type SyncProgressLike = {
  readonly isConnected: boolean;
  readonly appliedIndex: bigint;
  readonly highestRelevantWalletIndex: bigint;
};

const PROJECT_ROOT = join(import.meta.dirname, '..');
const PRIVATE_STATE_ID = 'veilpay-spending-policy';
const ZK_CONFIG_PATH = 'contracts/managed/spending_policy';

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
): Promise<void> => {
  logger.info('Syncing wallet with the network...');
  logger.info('A fresh seed scans the chain from genesis; expect roughly 20-30 minutes.');

  const startedAt = Date.now();
  let lastLoggedAt = 0;

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

  // testkit logs the master seed at info level while building the wallet; keep it
  // out of stdout and out of logs/.
  const walletProvider = await (async () => {
    const previousLevel = logger.level;
    logger.level = 'warn';
    try {
      return await MidnightWalletProvider.build(logger, environment, seed);
    } finally {
      logger.level = previousLevel;
    }
  })();
  // Drive startup ourselves rather than walletProvider.start(true), so the
  // initial sync gets a realistic time budget.
  const syncTimeoutMs = Number(process.env.VEILPAY_SYNC_TIMEOUT_MS ?? 3_600_000);
  await walletProvider.wallet.start(walletProvider.zswapSecretKeys, walletProvider.dustSecretKey);
  await waitForFullSync(walletProvider.wallet, logger, syncTimeoutMs);

  const balance = await waitForFunds(
    walletProvider.wallet,
    environment,
    true,
    walletProvider.unshieldedKeystore,
  );
  if (balance === 0n) {
    throw new Error(
      'Wallet holds no NIGHT after the faucet request. Fund it manually and run the deploy again.',
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
