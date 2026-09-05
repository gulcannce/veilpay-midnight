/**
 * Builds the read-only half of the Midnight.js provider set.
 *
 * Stage A of the provider wiring: enough to *look up* the deployed spending
 * policy, and nothing more. The three providers that can move value —
 * proving, balancing, submission — are present only as stubs that throw, so
 * that any code path which starts building a transaction fails loudly here
 * rather than reaching the wallet.
 */
import type { ConnectedAPI, Configuration } from '@midnight-ntwrk/dapp-connector-api';
import type {
  MidnightProviders,
  PrivateStateProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { createProofProvider } from '@midnight-ntwrk/midnight-js-types';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import type { VeilPayPrivateState } from './witnesses';
import { createMidnightProvider, createWalletProvider, type WalletKeys } from './walletAdapter';

/** The only circuit the spending policy exposes. */
export type VeilPayCircuitId = 'canSpend';

/** Private state key. Must match the one the Level 1 deployment used. */
export const PRIVATE_STATE_ID = 'veilpay-spending-policy';

/**
 * Where the dev server exposes the compiled ZK artifacts. Kept in step with
 * `ZK_ASSETS_ROUTE` in `vite.config.ts`.
 */
const ZK_ASSETS_ROUTE = '/zk';

/** `window.fetch`, kept bound to `window` so it can be passed around. */
const boundFetch: typeof globalThis.fetch = (...args) => window.fetch(...args);

/**
 * Character classes the private-state store requires a passphrase to span.
 *
 * `levelPrivateStateProvider` rejects a passphrase drawing on fewer than three
 * of these, and re-checks on every call. Checking here first turns a failure
 * deep inside a lookup into a message next to the input that caused it.
 */
const PASSPHRASE_CLASSES = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/] as const;

const REQUIRED_CLASSES = 3;

/**
 * Shortest passphrase the private-state store accepts.
 *
 * Sixteen is the store's own floor, not a preference: a shorter one is rejected
 * deep inside the first lookup with "Password is shorter than 16 characters".
 * Checking a lower number here would let exactly the failure this function
 * exists to pre-empt through.
 */
const MIN_PASSPHRASE_LENGTH = 16;

/**
 * Reports why a passphrase is unusable, or `null` when it is fine.
 *
 * @param passphrase The candidate, as typed by the user.
 */
export const describePassphraseProblem = (passphrase: string): string | null => {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  const classes = PASSPHRASE_CLASSES.filter((pattern) => pattern.test(passphrase)).length;
  if (classes < REQUIRED_CLASSES) {
    return (
      `Use at least ${REQUIRED_CLASSES} of: uppercase, lowercase, digits, symbols. ` +
      `Found ${classes}.`
    );
  }
  return null;
};

/**
 * Marks a provider that Stage A deliberately does not implement.
 *
 * Midnight.js types the provider set as a whole, so a read-only subset cannot
 * satisfy it. Rather than cast the gap away, every write-side method is a
 * function that throws — the type checker stays honest and the failure names
 * the missing piece.
 */
export class ProviderNotWiredError extends Error {
  /**
   * @param what The provider method that refused.
   * @param why What still has to be settled before it can be implemented.
   */
  constructor(what: string, why: string) {
    super(`${what} is not wired yet. ${why}`);
    this.name = 'ProviderNotWiredError';
  }
}

export type ReadOnlyProviders = MidnightProviders<
  VeilPayCircuitId,
  typeof PRIVATE_STATE_ID,
  VeilPayPrivateState
>;

/**
 * Assembles the provider set from what the connected wallet reports.
 *
 * The service URLs come from `getConfiguration()` rather than from a constant
 * in this repo: the connector spec asks DApps to use the wallet's own
 * endpoints, since the user may have pointed the wallet somewhere deliberately.
 *
 * @param api The connected wallet, asked for its proving provider.
 * @param configuration What the wallet reported for the current connection.
 * @param keys The wallet's keys, read once at connection time.
 * @param passphrase Encrypts the local private-state database. Held by the
 *   caller in memory for the lifetime of the page and never persisted — see
 *   {@link ReadOnlyProviders} usage in `useWallet`.
 */
export const createReadOnlyProviders = async (
  api: ConnectedAPI,
  configuration: Configuration,
  keys: WalletKeys,
  passphrase: string,
): Promise<ReadOnlyProviders> => {
  // Ledger serialization is network-scoped and reads this global, so it has to
  // agree with the wallet before any contract state is decoded.
  setNetworkId(configuration.networkId);

  const zkConfigProvider = new FetchZkConfigProvider<VeilPayCircuitId>(
    new URL(ZK_ASSETS_ROUTE, window.location.origin).toString(),
    // The provider defaults to `cross-fetch`, whose browser build hands back
    // `window.fetch` detached from `window`; calling it that way throws
    // "Illegal invocation". Pass a bound one instead.
    boundFetch,
  );

  // Proving is delegated to the wallet rather than to a proof server: the
  // wallet hands back a ledger-shaped `ProvingProvider`, and `createProofProvider`
  // is what the ledger transaction calls into when proving itself. The key
  // material never leaves this page — the wallet asks for it through the
  // provider below when it needs it.
  const provingProvider = await api.getProvingProvider(zkConfigProvider.asKeyMaterialProvider());

  return {
    publicDataProvider: indexerPublicDataProvider(
      configuration.indexerUri,
      configuration.indexerWsUri,
      // The provider defaults to `isomorphic-ws`, which resolves to nothing in
      // a browser bundle — the build reports the import as always undefined, so
      // every subscription would fail at the point of use rather than here.
      // The platform's own constructor is what that package stands in for.
      WebSocket as unknown as Parameters<typeof indexerPublicDataProvider>[2],
    ),
    zkConfigProvider,
    privateStateProvider: levelPrivateStateProvider<
      typeof PRIVATE_STATE_ID,
      VeilPayPrivateState
    >({
      privateStateStoreName: PRIVATE_STATE_ID,
      // Closed over rather than stored: the passphrase exists only in this
      // page's memory, so closing the tab is what disposes of it.
      privateStoragePasswordProvider: () => passphrase,
      accountId: keys.shieldedAddress,
    }) as PrivateStateProvider<typeof PRIVATE_STATE_ID, VeilPayPrivateState>,
    proofProvider: createProofProvider(provingProvider),
    walletProvider: createWalletProvider(keys),
    midnightProvider: createMidnightProvider(),
  };
};
