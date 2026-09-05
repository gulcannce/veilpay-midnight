/**
 * Thin wrapper over the Midnight DApp Connector API as injected by wallets
 * (Lace) under `window.midnight`.
 *
 * Scope of this module is deliberately narrow: discovery, connection, and
 * reading back what the wallet says about itself. It builds no Midnight.js
 * providers and creates no transactions.
 */
import type { ConnectedAPI, Configuration, ConnectionStatus } from '@midnight-ntwrk/dapp-connector-api';

/**
 * The version of `@midnight-ntwrk/dapp-connector-api` this app is written
 * against. A wallet reports the version it implemented via `apiVersion`.
 */
export const SUPPORTED_API_MAJOR = 4;

export type DiscoveredWallet = {
  /** Key under `window.midnight`. A wallet may inject several API versions. */
  readonly key: string;
  readonly rdns: string;
  readonly name: string;
  /** Already screened by {@link safeIconUrl}; `undefined` when not displayable. */
  readonly icon: string | undefined;
  readonly apiVersion: string;
  readonly compatibility: Compatibility;
};

export type Compatibility =
  | { readonly kind: 'supported' }
  | { readonly kind: 'unknown-version'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string };

/**
 * Wallet-supplied strings are untrusted. React escapes text content, which
 * covers `name` and `rdns`, but an icon flows into an attribute, so restrict it
 * to schemes that cannot execute: remote images over TLS, or inline image data.
 */
const safeIconUrl = (icon: unknown): string | undefined => {
  if (typeof icon !== 'string' || icon.length === 0) return undefined;
  if (icon.startsWith('data:image/')) return icon;
  try {
    return new URL(icon).protocol === 'https:' ? icon : undefined;
  } catch {
    return undefined;
  }
};

const classifyVersion = (apiVersion: unknown): Compatibility => {
  if (typeof apiVersion !== 'string' || apiVersion.length === 0) {
    return { kind: 'unknown-version', reason: 'Wallet reported no apiVersion.' };
  }
  const major = Number.parseInt(apiVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major)) {
    return { kind: 'unknown-version', reason: `Unparseable apiVersion "${apiVersion}".` };
  }
  if (major !== SUPPORTED_API_MAJOR) {
    return {
      kind: 'unsupported',
      reason: `Wallet implements connector API v${major}; this app targets v${SUPPORTED_API_MAJOR}.`,
    };
  }
  return { kind: 'supported' };
};

/**
 * Lists the wallet APIs currently injected into the page.
 *
 * Injection races page load, so callers should re-run this rather than assume a
 * single read at startup is final.
 */
export const discoverWallets = (): DiscoveredWallet[] => {
  const injected = window.midnight;
  if (!injected) return [];

  return Object.entries(injected).flatMap(([key, api]) => {
    if (!api || typeof api.connect !== 'function') return [];
    return [
      {
        key,
        rdns: typeof api.rdns === 'string' ? api.rdns : key,
        name: typeof api.name === 'string' && api.name.length > 0 ? api.name : key,
        icon: safeIconUrl(api.icon),
        apiVersion: typeof api.apiVersion === 'string' ? api.apiVersion : '',
        compatibility: classifyVersion(api.apiVersion),
      },
    ];
  });
};

export class WalletConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WalletConnectionError';
  }
}

/** Ceiling on wallet-supplied error text, which is untrusted and unbounded. */
const REASON_MAX_LENGTH = 200;

/**
 * Explains why the wallet rejected a connection.
 *
 * The connector rejects with a `DAppConnectorAPIError` carrying `code` and
 * `reason`; Lace puts the real cause in `reason` and leaves `message` generic.
 * The most common rejection is not a decline at all — a wallet sitting on
 * another network answers "Network ID mismatch" without ever showing the user a
 * prompt, so reporting every rejection as "declined" sends them looking in the
 * wrong place. The text comes from the wallet, so it is treated as untrusted
 * input: read as a string and truncated before it reaches the UI.
 *
 * @param error Whatever `connect()` rejected with.
 * @param networkId The network that was asked for, named in the mismatch hint.
 */
const describeRejection = (error: unknown, networkId: string): string => {
  const generic = 'The wallet did not complete the connection. It may have been declined.';
  const raw =
    typeof error === 'object' && error !== null && 'reason' in error
      ? String((error as { reason: unknown }).reason)
      : '';
  const reason = raw.slice(0, REASON_MAX_LENGTH).trim();
  if (reason.length === 0) return generic;
  if (/network id mismatch/i.test(reason)) {
    return (
      `The wallet refused the connection: ${reason}. ` +
      `Switch its Midnight network to "${networkId}" and connect again.`
    );
  }
  return `The wallet did not complete the connection: ${reason}`;
};

/**
 * Asks the named wallet to connect for `networkId`.
 *
 * Resolution means the user approved; rejection is normal and expected when
 * they decline the prompt — or when the wallet is on another network, which it
 * refuses without prompting at all.
 */
export const connectWallet = async (key: string, networkId: string): Promise<ConnectedAPI> => {
  const api = window.midnight?.[key];
  if (!api) {
    throw new WalletConnectionError(`Wallet "${key}" is no longer available. Was it disabled?`);
  }
  try {
    return await api.connect(networkId);
  } catch (error) {
    throw new WalletConnectionError(describeRejection(error, networkId), { cause: error });
  }
};

export type WalletSession = {
  readonly configuration: Configuration;
  readonly status: ConnectionStatus;
};

/** Reads the wallet's service configuration and current connection status. */
export const readSession = async (api: ConnectedAPI): Promise<WalletSession> => {
  const [configuration, status] = await Promise.all([api.getConfiguration(), api.getConnectionStatus()]);
  return { configuration, status };
};
