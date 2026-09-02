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

/**
 * Asks the named wallet to connect for `networkId`.
 *
 * Resolution means the user approved; rejection is normal and expected when
 * they decline the prompt.
 */
export const connectWallet = async (key: string, networkId: string): Promise<ConnectedAPI> => {
  const api = window.midnight?.[key];
  if (!api) {
    throw new WalletConnectionError(`Wallet "${key}" is no longer available. Was it disabled?`);
  }
  try {
    return await api.connect(networkId);
  } catch (error) {
    throw new WalletConnectionError(
      'The wallet did not complete the connection. It may have been declined.',
      { cause: error },
    );
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
