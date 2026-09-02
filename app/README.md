# VeilPay — Level 2 frontend

Browser client for the VeilPay spending policy. This directory is self-contained:
it has its own `package.json` and `tsconfig.json`, and nothing here changes the
Level 1 contract, its compiled artifacts, or the Node-side deployment script in
the repository root.

## Current scope

The app connects a Midnight wallet, confirms the deployed contract on chain, and
runs the `canSpend` circuit with the wallet producing a real zero-knowledge
proof. It stops one step short of the chain: the proven transaction is measured
and discarded.

Implemented:

- Discovery of every DApp Connector API injected under `window.midnight`, with
  `rdns`, `name`, `icon` and `apiVersion` for each
- `connect('preview')`, `getConnectionStatus()`, `getConfiguration()`, and an
  explicit warning when the wallet's `networkId` is not `preview`
- The Midnight.js provider set, built from what the wallet reports:
  `indexerPublicDataProvider`, `FetchZkConfigProvider`, `levelPrivateStateProvider`,
  and a proof provider backed by the wallet's own `getProvingProvider()`
- `findDeployedContract` against the live Preview contract, checking the on-chain
  verifier key byte-for-byte against the one compiled in this repository
- `canSpend(price)` — the circuit runs locally against the private budget and the
  wallet proves the result
- Byte-count evidence for the privacy claim: the same call measured unproven,
  proven, and with `eraseProofs()` applied

Deliberately not implemented: `balanceTx` and `submitTx`. Both throw
`ProviderNotWiredError`, so no code path here can reach the chain — the boundary
is enforced in the provider set rather than by convention.

## Proving happens in the wallet

There is no local proof server. Lace implements `getProvingProvider()`, which
returns a `{ check, prove }` pair matching the ledger's own `ProvingProvider`
type, and `createProofProvider` plugs it straight in. Proving a `canSpend` call
takes roughly 1.4 seconds end to end.

One consequence worth knowing before wiring anything further: reading the wallet
keys takes about two seconds, and `balanceUnsealedTransaction` has been measured
at 136 seconds. Any UI built on top of those needs a real waiting state.

## There is no `disconnect`

The Midnight DApp Connector API (`@midnight-ntwrk/dapp-connector-api` 4.0.1)
exposes **no `disconnect` method**. The connected API surface is:

```
balanceSealedTransaction, balanceUnsealedTransaction, check, getConfiguration,
getConnectionStatus, getDustAddress, getDustBalance, getProverKey,
getProvingProvider, getShieldedAddresses, getShieldedBalances, getTxHistory,
getUnshieldedAddress, getUnshieldedBalances, getVerifierKey, getZKIR, hintUsage,
makeIntent, makeTransfer, prove, signData, submitTransaction
```

So a DApp cannot revoke its own access. The button in the UI is therefore
labelled **“End session here”**, not “Disconnect”: it clears this page's local
session state and drops the handle on the wallet, and the UI says plainly that
the permission itself has to be removed from the wallet's own settings. Do not
rename this to “Disconnect” — it would promise something the API cannot do.

## Untrusted wallet metadata

`name`, `rdns` and `icon` are supplied by the wallet and are treated as hostile
input. React escapes the text values. The icon flows into an `img` attribute, so
`src/wallet/connector.ts` accepts only `https:` URLs and `data:image/` URIs;
anything else (notably `javascript:`) is dropped and no image is rendered.

## Network configuration

Service URLs come from the connected wallet via `getConfiguration()`, not from
hardcoded constants — the wallet user may point their wallet at their own
services. `src/config/network.ts` holds Preview reference values used only to
detect and explain a mismatch.

## Running

```bash
cd app
npm install      # first time only
npm run dev      # http://localhost:5173
```

Then open the page in a browser that has the Lace wallet extension installed and
press **Connect**. Without a wallet extension the page renders an empty state.

Other scripts:

```bash
npm run typecheck
npm run build
```

## Layout

```text
app/
  index.html
  vite.config.ts             serves the compiled ZK artifacts at /zk; dedupes @midnight-ntwrk/*
  src/
    main.tsx                 Buffer polyfill, then mounts the app
    App.tsx                  discovery list, session panel, deployment lookup, proof panel
    styles.css
    config/network.ts        Preview reference values, contract address
    wallet/connector.ts      window.midnight access, version and icon screening
    wallet/useWallet.ts      connection state machine, deployment lookup, proof run
    midnight/providers.ts    the Midnight.js provider set; balance/submit refuse
    midnight/contract.ts     the compiled contract, loaded from the repository root
    midnight/witnesses.ts    re-export of the root witnesses — never a second copy
    midnight/walletAdapter.ts wallet keys and the wallet/midnight provider adapters
    midnight/verifyDeployment.ts findDeployedContract plus the verifier-key check
    midnight/proveCanSpend.ts the circuit call, the proof, and the size measurements
```

### Two copies of the runtime will break proving

The compiled contract lives at the repository root while the app resolves its own
`node_modules`, so `@midnight-ntwrk/compact-runtime` can be loaded twice. Two
wasm-bindgen instances mean `instanceof` fails inside `_assertClass` and proving
dies in a way that reads as a type error. `vite.config.ts` pins this with
`resolve.dedupe` over the fourteen `@midnight-ntwrk/*` packages present in both
trees. If proving starts failing after a dependency change, check that list
first.
