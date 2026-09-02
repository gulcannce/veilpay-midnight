/**
 * Builds a wallet whose sync survives being interrupted.
 *
 * A freshly seeded wallet scans all three chains from genesis every time it
 * starts. On Preview that costs about half an hour; on Preprod the dust chain
 * alone is roughly 1.5M events, so an interrupted run throws away hours of work
 * and the next one begins again at zero. That is what happened to the two
 * abandoned Preprod attempts recorded in `logs/veilpay-deploy.log`: neither
 * crashed, both were stopped by hand, and the second started over from the
 * beginning rather than resuming where the first had reached.
 *
 * The wallet SDK already supports the fix. Each of the three wallets exposes
 * `serializeState()` and its class exposes `restore()`, and testkit's
 * `MidnightWalletProvider.withWallet` accepts an externally built facade. This
 * module joins those pieces: state is written to disk as the sync progresses,
 * and a later run picks up from the last checkpoint.
 *
 * testkit ships a `WalletSaveStateProvider` that does something similar, but it
 * saves the shielded wallet only — and the dust chain is the slow one.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  DustSecretKey,
  LedgerParameters,
  ZswapSecretKeys,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  createKeystore,
  DustWallet,
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  PublicKey,
  ShieldedWallet,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
} from '@midnight-ntwrk/wallet-sdk';
import {
  MidnightWalletProvider,
  WalletSeeds,
  createLogger,
  type EnvironmentConfiguration,
} from '@midnight-ntwrk/testkit-js';

type Logger = ReturnType<typeof createLogger>;

/** Bumped whenever the payload shape changes, so old files are ignored rather than misread. */
const CHECKPOINT_VERSION = 1;

/** Matches testkit's own default, and is already covered by `.gitignore`. */
export const DEFAULT_CHECKPOINT_DIRECTORY = '.states';

type CheckpointPayload = {
  readonly version: number;
  readonly networkId: string;
  /**
   * Identifies the wallet without storing anything that could spend from it.
   *
   * Restoring one wallet's chain state into another wallet's keys would produce
   * a wallet that is confidently wrong about its own balance, so the seed has to
   * be checked — but the seed itself must never touch disk here. `.env` is the
   * only place that holds it, and this file sits next to it.
   */
  readonly seedFingerprint: string;
  readonly savedAt: string;
  readonly shielded: string;
  readonly unshielded: string;
  readonly dust: string;
};

/** Truncated because it is an equality check, not a security boundary. */
const fingerprint = (seed: string): string =>
  createHash('sha256').update(seed).digest('hex').slice(0, 16);

const checkpointPath = (directory: string, networkId: string): string =>
  join(directory, `veilpay.${networkId}.checkpoint.json.gz`);

/**
 * Mirrors testkit's internal `mapEnvironmentToConfiguration`.
 *
 * Not exported by testkit, and needed here because building the wallets by hand
 * is the only way to hand them restored state. Kept deliberately literal so a
 * future testkit change is easy to diff against.
 */
const toWalletConfiguration = (environment: EnvironmentConfiguration) => ({
  indexerClientConnection: {
    indexerHttpUrl: environment.indexer,
    indexerWsUrl: environment.indexerWS,
  },
  provingServerUrl: new URL(environment.proofServer),
  networkId: environment.walletNetworkId,
  relayURL: new URL(environment.nodeWS),
  txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  costParameters: {
    feeBlocksMargin: 5,
  },
});

/**
 * Reads a usable checkpoint, or `null` when there is nothing to resume from.
 *
 * Every rejection is a reason to sync from genesis rather than an error: a
 * missing, stale, corrupt or foreign checkpoint all mean the same thing to the
 * caller, and none of them should stop a deployment.
 */
const readCheckpoint = (
  logger: Logger,
  path: string,
  networkId: string,
  seedFingerprint: string,
): CheckpointPayload | null => {
  if (!existsSync(path)) {
    logger.info(`No wallet checkpoint at ${path}; syncing from genesis.`);
    return null;
  }
  try {
    const payload = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as CheckpointPayload;
    if (payload.version !== CHECKPOINT_VERSION) {
      logger.warn(`Ignoring checkpoint written by an older format (v${payload.version}).`);
      return null;
    }
    if (payload.networkId !== networkId) {
      logger.warn(
        `Ignoring checkpoint for '${payload.networkId}' while deploying to '${networkId}'.`,
      );
      return null;
    }
    if (payload.seedFingerprint !== seedFingerprint) {
      logger.warn('Ignoring checkpoint: it belongs to a different wallet seed.');
      return null;
    }
    logger.info(`Resuming from wallet checkpoint saved at ${payload.savedAt}.`);
    return payload;
  } catch (error) {
    logger.warn(
      `Could not read the wallet checkpoint (${error instanceof Error ? error.message : String(error)}); syncing from genesis.`,
    );
    return null;
  }
};

export type CheckpointedWallet = {
  readonly walletProvider: MidnightWalletProvider;
  /**
   * Writes the current sync position to disk.
   *
   * Safe to call repeatedly and safe to call while the sync is running; the
   * write is atomic, so an interrupted save leaves the previous checkpoint
   * intact rather than a half-written file.
   */
  readonly saveCheckpoint: () => Promise<void>;
};

/**
 * Builds a wallet provider that resumes from disk when it can.
 *
 * @param logger Where progress is reported.
 * @param environment The resolved network configuration.
 * @param seed Hex master seed. Never written to disk by this module.
 * @param directory Where checkpoints live. Must stay gitignored.
 */
export const buildCheckpointedWallet = async (
  logger: Logger,
  environment: EnvironmentConfiguration,
  seed: string,
  directory: string = DEFAULT_CHECKPOINT_DIRECTORY,
): Promise<CheckpointedWallet> => {
  const seeds = WalletSeeds.fromMasterSeed(seed);
  const networkId = environment.walletNetworkId;
  const path = checkpointPath(directory, String(networkId));
  const seedFingerprint = fingerprint(seed);
  const saved = readCheckpoint(logger, path, String(networkId), seedFingerprint);

  const configuration = toWalletConfiguration(environment);
  const unshieldedKeystore = createKeystore(seeds.unshielded, networkId);

  // Restore and fresh-start return the same wallet type, so the facade below is
  // assembled identically either way.
  const shieldedWallet = saved
    ? ShieldedWallet(configuration).restore(saved.shielded)
    : ShieldedWallet(configuration).startWithSeed(seeds.shielded);

  const unshieldedWallet = saved
    ? UnshieldedWallet(configuration).restore(saved.unshielded)
    : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

  const dustConfiguration = {
    ...configuration,
    costParameters: {
      ledgerParams: LedgerParameters.initialParameters(),
      additionalFeeOverhead: 0n,
      feeBlocksMargin: 5,
    },
  };
  const dustWallet = saved
    ? DustWallet(dustConfiguration).restore(saved.dust)
    : DustWallet(dustConfiguration).startWithSeed(
        seeds.dust,
        LedgerParameters.initialParameters().dust,
      );

  const wallet = await WalletFacade.init({
    configuration,
    shielded: () => shieldedWallet,
    unshielded: () => unshieldedWallet,
    dust: () => dustWallet,
  });

  // Left unstarted on purpose: the caller drives `start` so it can also own the
  // sync timeout and the progress reporting.
  const walletProvider = await MidnightWalletProvider.withWallet(
    logger,
    environment,
    wallet,
    ZswapSecretKeys.fromSeed(seeds.shielded),
    DustSecretKey.fromSeed(seeds.dust),
    unshieldedKeystore,
  );

  const saveCheckpoint = async (): Promise<void> => {
    const payload: CheckpointPayload = {
      version: CHECKPOINT_VERSION,
      networkId: String(networkId),
      seedFingerprint,
      savedAt: new Date().toISOString(),
      shielded: await wallet.shielded.serializeState(),
      unshielded: await wallet.unshielded.serializeState(),
      dust: await wallet.dust.serializeState(),
    };

    mkdirSync(directory, { recursive: true });
    // Write beside the target and rename over it: rename is atomic within a
    // directory, so a process killed mid-write cannot destroy the checkpoint it
    // is replacing — which is the exact failure this module exists to prevent.
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')));
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    logger.info(`Wallet checkpoint saved to ${path}`);
  };

  return { walletProvider, saveCheckpoint };
};
