import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import {
  connectWallet,
  discoverWallets,
  readSession,
  WalletConnectionError,
  type DiscoveredWallet,
  type WalletSession,
} from './connector';
import { EXPECTED_NETWORK_ID, SPENDING_POLICY_CONTRACT_ADDRESS } from '../config/network';
import {
  createReadOnlyProviders,
  describePassphraseProblem,
  type ReadOnlyProviders,
} from '../midnight/providers';
import { fetchWalletKeys } from '../midnight/walletAdapter';
import { verifyDeployment, type DeploymentFacts } from '../midnight/verifyDeployment';
import { proveCanSpend, type ProofAttempt } from '../midnight/proveCanSpend';

export type Phase = 'idle' | 'connecting' | 'connected';

/** Progress of the read-only lookup of the deployed spending policy. */
export type VerificationPhase = 'idle' | 'running' | 'done' | 'failed';

/** Progress of a `canSpend` call. Shares the shape of {@link VerificationPhase}. */
export type ProofPhase = 'idle' | 'running' | 'done' | 'failed';

/**
 * Turns a caught value into something worth showing the user.
 *
 * Some failures arrive with an empty `message`: WebCrypto rejects with a bare
 * `DOMException` whose name is the only description it carries, so reading
 * `message` alone renders a failure as blank and the UI looks like it never
 * ran. Fall back to the name, then to the stringified value, and never return
 * an empty string.
 */
const describeError = (caught: unknown): string => {
  if (caught instanceof Error) {
    if (caught.message.length > 0) return caught.message;
    if (caught.name.length > 0) return `${caught.name} (no further detail)`;
  }
  const rendered = String(caught);
  return rendered.length > 0 ? rendered : 'Unknown failure.';
};

/** How often to re-ask the wallet whether the connection is still live. */
const STATUS_POLL_MS = 10_000;
/** Wallets inject asynchronously; re-scan briefly after mount. */
const DISCOVERY_POLL_MS = 1_000;
const DISCOVERY_WINDOW_MS = 10_000;

export type NetworkMismatch = {
  readonly expected: string;
  readonly actual: string;
};

export const useWallet = () => {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>(() => discoverWallets());
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState<WalletSession | null>(null);
  const [connectedKey, setConnectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<VerificationPhase>('idle');
  const [deployment, setDeployment] = useState<DeploymentFacts | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [proofPhase, setProofPhase] = useState<ProofPhase>('idle');
  const [proof, setProof] = useState<ProofAttempt | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const apiRef = useRef<ConnectedAPI | null>(null);
  // Built once by the deployment lookup and reused by the proof, because
  // assembling it costs a round trip to the wallet for the keys (~2s) and a
  // second passphrase prompt the user has already answered.
  const providersRef = useRef<ReadOnlyProviders | null>(null);

  const rescan = useCallback(() => setWallets(discoverWallets()), []);

  // Poll for injected wallets for a short window after mount, then stop: an
  // indefinite timer would keep re-rendering a page that has already settled.
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setWallets(discoverWallets());
      if (Date.now() - started > DISCOVERY_WINDOW_MS) clearInterval(timer);
    }, DISCOVERY_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const connect = useCallback(async (key: string) => {
    setPhase('connecting');
    setError(null);
    try {
      const api = await connectWallet(key, EXPECTED_NETWORK_ID);
      const next = await readSession(api);
      apiRef.current = api;
      setSession(next);
      setConnectedKey(key);
      setPhase('connected');
    } catch (caught) {
      apiRef.current = null;
      setSession(null);
      setConnectedKey(null);
      setPhase('idle');
      setError(
        caught instanceof WalletConnectionError
          ? caught.message
          : `Unexpected failure while connecting: ${String(caught)}`,
      );
    }
  }, []);

  /**
   * Drops our reference to the wallet.
   *
   * The connector API exposes no `disconnect`, so this cannot revoke the
   * wallet-side grant — it only ends the session as far as this page is
   * concerned. The UI must not claim more than that.
   */
  const releaseSession = useCallback(() => {
    apiRef.current = null;
    // Drops the passphrase closed over by the private-state provider along with
    // the provider set itself; nothing here outlives the session.
    providersRef.current = null;
    setSession(null);
    setConnectedKey(null);
    setPhase('idle');
    setError(null);
    setVerification('idle');
    setDeployment(null);
    setVerificationError(null);
    setProofPhase('idle');
    setProof(null);
    setProofError(null);
  }, []);

  /**
   * Looks up the deployed spending policy through the wallet's own indexer.
   *
   * Read-only by construction: the provider set this builds leaves proving,
   * balancing and submission unimplemented, so nothing here can produce a
   * transaction even if a later change tried to.
   */
  const verifyDeployedContract = useCallback(
    async (passphrase: string) => {
    const api = apiRef.current;
    if (!api || !session) return;

    const problem = describePassphraseProblem(passphrase);
    if (problem !== null) {
      setVerificationError(problem);
      setVerification('failed');
      return;
    }

    setVerification('running');
    setVerificationError(null);
    setDeployment(null);
    try {
      // Give the wallet the chance to ask for this permission once, up front,
      // rather than mid-lookup. The v4 types declare `hintUsage` as part of
      // every connected API, but Lace 2.2.3 does not always provide it, so it
      // is treated as the optimisation it is rather than a requirement.
      if (typeof api.hintUsage === 'function') {
        await api.hintUsage(['getShieldedAddresses', 'getProvingProvider']);
      }
      // The local private-state database is scoped per wallet account; the
      // shielded address is the stable identifier the connector offers for it.
      const keys = await fetchWalletKeys(api, session.configuration.networkId);
      const providers = await createReadOnlyProviders(
        api,
        session.configuration,
        keys,
        passphrase,
      );
      setDeployment(await verifyDeployment(providers, SPENDING_POLICY_CONTRACT_ADDRESS));
      providersRef.current = providers;
      setVerification('done');
    } catch (caught) {
      providersRef.current = null;
      setVerificationError(describeError(caught));
      setVerification('failed');
    }
    },
    [session],
  );

  /**
   * Proves `canSpend(price)` against the private budget held in this browser.
   *
   * Requires the deployment lookup to have run: that is what builds the
   * provider set, and running against a contract we have not confirmed on chain
   * would prove a claim about the wrong verifier key.
   *
   * @param price The purchase amount to test. Public input to the circuit.
   */
  const runProof = useCallback(async (price: bigint) => {
    const providers = providersRef.current;
    if (!providers) {
      setProofError('Verify the deployment first — the proof runs against that contract.');
      setProofPhase('failed');
      return;
    }
    if (price < 0n) {
      setProofError('The price cannot be negative.');
      setProofPhase('failed');
      return;
    }

    setProofPhase('running');
    setProofError(null);
    setProof(null);
    try {
      setProof(await proveCanSpend(providers, SPENDING_POLICY_CONTRACT_ADDRESS, price));
      setProofPhase('done');
    } catch (caught) {
      setProofError(describeError(caught));
      setProofPhase('failed');
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const next = await readSession(api);
      setSession(next);
    } catch (caught) {
      setError(`Lost contact with the wallet: ${String(caught)}`);
    }
  }, []);

  useEffect(() => {
    if (phase !== 'connected') return;
    const timer = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [phase, refreshStatus]);

  const actualNetwork = session?.configuration.networkId;
  const networkMismatch: NetworkMismatch | null =
    actualNetwork !== undefined && actualNetwork !== EXPECTED_NETWORK_ID
      ? { expected: EXPECTED_NETWORK_ID, actual: actualNetwork }
      : null;

  return {
    wallets,
    phase,
    session,
    connectedKey,
    error,
    networkMismatch,
    connect,
    releaseSession,
    refreshStatus,
    rescan,
    verification,
    deployment,
    verificationError,
    verifyDeployedContract,
    proofPhase,
    proof,
    proofError,
    runProof,
  };
};
