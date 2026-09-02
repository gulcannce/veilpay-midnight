import { useState } from 'react';
import { useWallet } from './wallet/useWallet';
import { SUPPORTED_API_MAJOR, type DiscoveredWallet } from './wallet/connector';
import { EXPECTED_NETWORK_ID, SPENDING_POLICY_CONTRACT_ADDRESS } from './config/network';

const WalletRow = ({
  wallet,
  busy,
  onConnect,
}: {
  wallet: DiscoveredWallet;
  busy: boolean;
  onConnect: (key: string) => void;
}) => {
  const blocked = wallet.compatibility.kind === 'unsupported';
  return (
    <div className="wallet">
      {/* Wallet-supplied icon, restricted to https: / data:image at discovery. */}
      {wallet.icon ? <img src={wallet.icon} alt="" /> : null}
      <div className="meta">
        {/* React escapes these; the wallet controls both strings. */}
        <div className="name">{wallet.name}</div>
        <div className="sub">
          {wallet.rdns} · connector API {wallet.apiVersion || 'unreported'}
          {wallet.compatibility.kind !== 'supported' ? ` · ${wallet.compatibility.reason}` : ''}
        </div>
      </div>
      <button disabled={busy || blocked} onClick={() => onConnect(wallet.key)}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
};

export const App = () => {
  const {
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
  } = useWallet();

  // Lives here and nowhere else: component state is discarded with the page,
  // which is the whole point of not persisting it.
  const [passphrase, setPassphrase] = useState('');
  const [price, setPrice] = useState('250');

  const configuration = session?.configuration;
  const status = session?.status;

  return (
    <main>
      <h1>VeilPay</h1>
      <p className="lede">
        Level 2 frontend: connect a Midnight wallet, look up the deployed spending policy through
        the wallet’s own services, then prove a purchase fits a budget the page never reveals.
        Balancing and submission stay unwired — the proof is built and measured here, and nothing
        is sent to the chain.
      </p>

      {error ? <p className="note bad">{error}</p> : null}

      {networkMismatch ? (
        <p className="note warn">
          Network mismatch — the wallet is connected to <code>{networkMismatch.actual}</code>, but the
          deployed spending policy lives on <code>{networkMismatch.expected}</code>. Switch networks in
          the wallet before going further.
        </p>
      ) : null}

      <section className="panel">
        <h2>Detected wallets</h2>
        {wallets.length === 0 ? (
          <p className="empty">
            No wallet found under <code>window.midnight</code>. Install the Lace wallet extension and
            reload. Wallets inject shortly after page load, so this list refreshes for a few seconds.
          </p>
        ) : (
          wallets.map((wallet) => (
            <WalletRow
              key={wallet.key}
              wallet={wallet}
              busy={phase === 'connecting'}
              onConnect={connect}
            />
          ))
        )}
        <div className="row">
          <button className="secondary" onClick={rescan}>
            Rescan
          </button>
        </div>
      </section>

      {phase === 'connected' && configuration ? (
        <section className="panel">
          <h2>Wallet session</h2>
          <p className={status?.status === 'connected' ? 'note ok' : 'note warn'}>
            {status?.status === 'connected'
              ? `Connected to ${status.networkId}.`
              : 'The wallet reports the connection as disconnected.'}
          </p>
          <dl className="kv">
            <dt>Wallet key</dt>
            <dd>{connectedKey}</dd>
            <dt>Network id</dt>
            <dd>{configuration.networkId}</dd>
            <dt>Indexer</dt>
            <dd>{configuration.indexerUri}</dd>
            <dt>Indexer WS</dt>
            <dd>{configuration.indexerWsUri}</dd>
            <dt>Substrate node</dt>
            <dd>{configuration.substrateNodeUri}</dd>
            <dt>Prover server</dt>
            <dd>
              {configuration.proverServerUri ?? 'not reported'}
              {configuration.proverServerUri ? ' (deprecated field)' : ''}
            </dd>
          </dl>
          <div className="row">
            <button className="secondary" onClick={() => void refreshStatus()}>
              Refresh status
            </button>
            <button
              className="secondary"
              onClick={() => {
                setPassphrase('');
                releaseSession();
              }}
            >
              End session here
            </button>
          </div>
          <p className="note warn" style={{ marginTop: '1rem' }}>
            The connector API has no <code>disconnect</code>. “End session here” only drops this
            page’s handle on the wallet — it cannot revoke the permission you granted. Remove that in
            the wallet’s own settings.
          </p>
        </section>
      ) : null}

      {phase === 'connected' ? (
        <section className="panel">
          <h2>Deployed contract</h2>
          <p className="lede">
            Reads the spending policy through the wallet’s own indexer and checks the verifier key
            on chain against the one compiled here. Nothing is proven, balanced or submitted.
          </p>

          <p className="note warn">
            The local private-state database is encrypted with a passphrase you choose here. It is
            kept in this page’s memory only — never written to storage, never sent anywhere, and
            unrelated to your wallet’s password or recovery phrase. Closing the tab forgets it, and
            there is no recovery: lose it and the local state has to be rebuilt.
          </p>

          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              void verifyDeployedContract(passphrase);
            }}
          >
            <input
              type="password"
              // Not a credential any password manager should keep, and the
              // browser must not offer to save it.
              autoComplete="off"
              name="veilpay-local-state-passphrase"
              placeholder="Local state passphrase"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
            <button type="submit" disabled={verification === 'running' || networkMismatch !== null}>
              {verification === 'running' ? 'Looking up…' : 'Verify deployment'}
            </button>
          </form>

          {/* Checked against null, not truthiness: a failure that produced an
              empty string would otherwise render as nothing at all. */}
          {verificationError !== null ? <p className="note bad">{verificationError}</p> : null}

          {deployment ? (
            <>
              <p className="note ok">Found on chain, and the verifier key matches.</p>
              <dl className="kv">
                <dt>Contract address</dt>
                <dd>{deployment.contractAddress}</dd>
                <dt>Deploy transaction</dt>
                <dd>{deployment.txId}</dd>
                <dt>Block height</dt>
                <dd>{deployment.blockHeight}</dd>
                <dt>Block hash</dt>
                <dd>{deployment.blockHash}</dd>
              </dl>
            </>
          ) : null}

        </section>
      ) : null}

      {verification === 'done' ? (
        <section className="panel">
          <h2>Prove a purchase</h2>
          <p className="lede">
            Runs <code>canSpend(price)</code> against the budget stored in this browser and asks the
            wallet to prove it. The price is a public input. The budget is a witness: it is read
            inside the circuit and never appears in the transaction, so what comes back is a proven
            yes or no and nothing else.
          </p>

          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              void runProof(BigInt(price));
            }}
          >
            <input
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              name="veilpay-price"
              placeholder="Purchase price"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
            {/* /^\d+$/ rather than Number(): BigInt() throws on an empty string,
                on a decimal, and on the "e" an number input still accepts. */}
            <button type="submit" disabled={proofPhase === 'running' || !/^\d+$/.test(price)}>
              {proofPhase === 'running' ? 'Proving…' : 'Prove'}
            </button>
          </form>

          {proofError !== null ? <p className="note bad">{proofError}</p> : null}

          {proof ? (
            <>
              <p className={proof.canSpend ? 'note ok' : 'note warn'}>
                {proof.canSpend
                  ? 'Proven: this purchase is within budget.'
                  : 'Proven: this purchase is over budget.'}{' '}
                The budget itself was not disclosed.
              </p>
              <dl className="kv">
                <dt>Circuit result</dt>
                <dd>{String(proof.canSpend)}</dd>
                <dt>Proving time</dt>
                <dd>{proof.provingMs} ms</dd>
                {proof.sizes ? (
                  <>
                    <dt>Unproven call</dt>
                    <dd>{proof.sizes.unprovenBytes} bytes</dd>
                    <dt>Proven call</dt>
                    <dd>{proof.sizes.provenBytes} bytes</dd>
                    <dt>Public transcript (proofs erased)</dt>
                    <dd>{proof.sizes.erasedBytes} bytes</dd>
                    <dt>Zero-knowledge proof</dt>
                    <dd>{proof.sizes.proofBytes} bytes</dd>
                  </>
                ) : null}
              </dl>
              {proof.sizes ? (
                <p className="note">
                  The observable privacy behaviour, in numbers: {proof.sizes.proofBytes} bytes of
                  proof convince a verifier the check passed, while the{' '}
                  {proof.sizes.erasedBytes}-byte public transcript left after erasing them carries
                  the price and the boolean — and no budget. Change the budget and re-run: the
                  answer changes, these shapes do not.
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      <section className="panel">
        <h2>Target</h2>
        <dl className="kv">
          <dt>Expected network</dt>
          <dd>{EXPECTED_NETWORK_ID}</dd>
          <dt>Spending policy</dt>
          <dd>{SPENDING_POLICY_CONTRACT_ADDRESS}</dd>
          <dt>Connector API</dt>
          <dd>v{SUPPORTED_API_MAJOR}.x</dd>
        </dl>
      </section>
    </main>
  );
};
