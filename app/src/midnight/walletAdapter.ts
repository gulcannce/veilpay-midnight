/**
 * Adapters between the DApp Connector API and Midnight.js's provider interfaces.
 *
 * Two mismatches need bridging. Midnight.js reads the wallet's public keys
 * *synchronously* while the connector only offers them over a promise, so they
 * are fetched once at connection time and served from the cache below. And the
 * connector speaks Bech32m where Midnight.js wants hex.
 *
 * The two methods that can move value — `balanceTx` and `submitTx` — are
 * deliberately still refusals. Balancing hands a serialized transaction to the
 * wallet, and the encoding the wallet expects for that string is not stated
 * anywhere in the connector API; guessing it in code that nothing has exercised
 * would bury the question. It is settled in its own step, against a real
 * transaction, with the risk visible.
 */
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { parseCoinPublicKeyToHex, parseEncPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';
import { ProviderNotWiredError } from './providers';

/**
 * The wallet's shielded keys, in the form Midnight.js expects.
 *
 * `shieldedAddress` is kept in its original Bech32m form: it is not passed to
 * Midnight.js, only used to scope this wallet's local storage.
 */
export type WalletKeys = {
  readonly shieldedAddress: string;
  readonly coinPublicKey: string;
  readonly encryptionPublicKey: string;
};

/**
 * Reads the connected wallet's shielded keys once, converting to hex.
 *
 * @param api The connected wallet.
 * @param networkId The network the wallet reported, needed to decode Bech32m.
 */
export const fetchWalletKeys = async (
  api: ConnectedAPI,
  networkId: string,
): Promise<WalletKeys> => {
  const { shieldedAddress, shieldedCoinPublicKey, shieldedEncryptionPublicKey } =
    await api.getShieldedAddresses();
  return {
    shieldedAddress,
    coinPublicKey: parseCoinPublicKeyToHex(shieldedCoinPublicKey, networkId),
    encryptionPublicKey: parseEncPublicKeyToHex(shieldedEncryptionPublicKey, networkId),
  };
};

/**
 * A {@link WalletProvider} that can answer for the wallet's keys but not spend.
 *
 * @param keys The keys read at connection time by {@link fetchWalletKeys}.
 */
export const createWalletProvider = (keys: WalletKeys): WalletProvider => ({
  getCoinPublicKey: () => keys.coinPublicKey,
  getEncryptionPublicKey: () => keys.encryptionPublicKey,
  balanceTx: () =>
    Promise.reject(
      new ProviderNotWiredError(
        'walletProvider.balanceTx',
        'Balancing needs the wallet\'s expected encoding for a serialized transaction, which is unverified.',
      ),
    ),
});

/** A {@link MidnightProvider} that refuses to submit. */
export const createMidnightProvider = (): MidnightProvider => ({
  submitTx: () =>
    Promise.reject(
      new ProviderNotWiredError(
        'midnightProvider.submitTx',
        'Submission writes to the chain and is out of scope for this step.',
      ),
    ),
});
