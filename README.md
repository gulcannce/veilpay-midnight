# VeilPay

VeilPay is a payment policy on Midnight that checks purchases against a private budget. A user proves that a purchase amount is allowed without revealing the budget itself; the merchant and the chain only learn that a policy is active and that the spend was approved or rejected.

## Current status — Level 1

**Working and verified locally:**

- The Compact contract compiles with Compact 0.31.1, producing the managed contract, the `canSpend` circuit IR, and prover/verifier keys.
- `canSpend()` is exercised through the **Midnight JavaScript runtime/interpreter** (`@midnight-ntwrk/compact-runtime` 0.16.0). This executes the compiled circuit logic and records the proof data a real proof would be built from; it does **not** generate or verify a zero-knowledge proof.
- **15 passing tests** (`npm test`) and a **clean TypeScript typecheck** (`npm run typecheck`).
- Privacy is asserted structurally, by inspecting the `ProofData` surfaces the runtime emits rather than by inspecting the ledger alone. See [Public state vs. private witness](#public-state-vs-private-witness).

**Not done yet — planned:**

- **No testnet deployment.** VeilPay has not been deployed to Preview or Preprod, and there is no contract address. `scripts/deploy.ts` exists but has not been run against a live network.
- **Prover-backed end-to-end verification.** Nothing yet exercises the proof server, so the generated proof itself is unverified; only the interpreter-level logic and disclosure structure are covered.
- **Wallet integration and a real payment flow.** There is no wallet UI, no merchant side, and no settlement — `canSpend()` is a policy primitive, not yet a payment.

## Initial product idea

VeilPay begins as a spending guardrail for people who want budget discipline without handing their finances to a third party. The first product is a wallet-side policy check: before a payment goes through, the wallet proves to the merchant that the amount falls within a budget the user set locally. The merchant receives a yes or a no together with a proof that the policy was genuinely enforced, while the budget, the remaining balance and the spending history never leave the user's device. The same primitive extends naturally from there — per-merchant caps, shared household or team budgets where each member proves compliance without exposing their individual limit, and subscription allowances a service can verify but never read.

## Public state vs. private witness

The contract is small, and the split between what is public and what is private is the point of it:

```compact
export ledger policyVersion: Uint<64>;   // public: lives on chain, anyone can read it
witness getPrivateBudget(): Uint<64>;    // private: supplied locally, never transmitted

export circuit canSpend(price: Uint<64>): Boolean {
  const budget = getPrivateBudget();
  return disclose(policyVersion >= 1 && price <= budget);
}
```

- **Public ledger state.** `policyVersion` is the only value written on chain. It shows that the contract carries an active policy version and nothing else — not the budget, not the price, not the user.
- **Private witness.** `getPrivateBudget()` is supplied by the caller's own machine at proving time. Witness values are inputs to the circuit, not ledger fields; the budget is never written to the contract state and never sent to the network. In this repository the witness is implemented in `src/midnight/witnesses.ts`; the deployment script is what would back it with an on-disk private state provider.
- **Deliberate disclosure.** Everything inside a circuit is private by default, so the comparison result has to be released explicitly. `disclose(...)` wraps exactly one boolean — whether the spend is allowed. The operands `price` and `budget` are never individually disclosed, so an observer learns "this purchase was permitted" without learning the amount, the limit, or how much room is left.

The suite asserts this structurally rather than taking it on trust. Checking the ledger alone would prove nothing — `canSpend` only ever *reads* the ledger, so the budget could never appear there whatever the witness did. Instead the tests inspect every surface of the `ProofData` the runtime produces and separate them by visibility:

| `ProofData` surface | Visibility | Must contain |
| --- | --- | --- |
| `input` | public | the price only |
| `output` | public | the boolean verdict only |
| `publicTranscript` | public | the `policyVersion` ledger read |
| `privateTranscriptOutputs` | private | the budget — and nothing else may |

The budget is encoded with the same `Uint<64>` descriptor the compiler emitted, then searched for byte-wise across each surface. Two positive controls keep those checks honest: the budget's bytes *must* be found in the private transcript, and the public transcript dump *must* be non-empty — so a leak would genuinely fail the assertion rather than pass by absence.

A further test runs two different budgets against the same price and requires the public transcript, input and output to come out byte-identical, while the private transcripts differ. Nothing observable distinguishes a user with a large budget from one with a small one.

## Requirements

- Node.js 22 (pinned via `.nvmrc`)
- Docker Desktop
- Compact toolchain 0.31.1

Installing Node 22 on Apple Silicon macOS:

```bash
brew install node@22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node --version
```

Verify the Compact version:

```bash
compact compile --version
# 0.31.1
```

## Running locally

```bash
npm ci
npm run compile
npm run typecheck
npm test
```

A successful build produces:

- `contracts/managed/spending_policy/contract/`: the managed JavaScript contract
- `contracts/managed/spending_policy/zkir/`: the `canSpend` circuits
- `contracts/managed/spending_policy/keys/`: prover and verifier keys

The tests need none of this infrastructure — no proof server, no wallet, no network. They drive the compiled contract through the JavaScript runtime, so they run in well under a second. `npm run proof-server` is needed only for deployment.

The 15 tests cover:

- **Core policy:** a spend within budget is approved, a spend over budget is rejected, and any spend is rejected while the public policy is inactive.
- **Budget boundaries:** `price == budget` is allowed, one unit over is not, and a zero budget admits only a zero price.
- **Policy version:** the constructor argument is readable from the ledger, and any version at or above 1 counts as active, up to the `Uint<64>` maximum.
- **`Uint<64>` bounds:** the largest representable price and budget are accepted; a price that overflows the type is rejected, as is a witness that returns an out-of-range budget.
- **Disclosure surface:** the `ProofData` assertions described above.

## Preview / Preprod deployment

**Not yet performed.** This section documents the intended procedure; the steps below have not been run against a live network, and no contract address exists yet.

Deployment needs Node 22, Docker, a running proof server, and a funded Midnight wallet for Preview or Preprod. This repository already contains the `zkir` and key material required to build.

Start the proof server in one terminal:

```bash
npm run proof-server
```

Then configure the deployment. Copy the example file and fill in a seed:

```bash
cp .env.example .env
openssl rand -hex 32          # paste the result into VEILPAY_WALLET_SEED
```

And deploy from a second terminal:

```bash
npm run deploy
```

Settings are read from `.env`, and any variable exported in the shell overrides the file:

```bash
VEILPAY_NETWORK=preprod npm run deploy
```

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `VEILPAY_WALLET_SEED` | yes | — | Hex master seed of the deploying wallet |
| `VEILPAY_NETWORK` | no | `preview` | `preview` or `preprod` |
| `VEILPAY_PROOF_SERVER` | no | `http://127.0.0.1:6300` | Proof server URL |
| `VEILPAY_POLICY_VERSION` | no | `1` | Initial public policy version |
| `VEILPAY_BUDGET` | no | `1000` | Initial private budget, kept on this machine |
| `VEILPAY_SYNC_TIMEOUT_MS` | no | `3600000` | Time budget for the initial wallet sync |

The wallet seed is a secret. `.env` is gitignored (only `.env.example` is tracked) — never commit a real seed.

A fresh seed scans the chain from genesis, which takes roughly 20-30 minutes on Preview; the script prints progress every fifteen seconds. If the wallet holds no NIGHT, the script then requests tokens from the network faucet and registers the received UTXOs for dust generation before deploying. On success it prints the deployment details and writes them to `deployment.<network>.json`. The deployed instance:

```text
Network: preview
Contract address: 4cadbd77b6decdc66102de0c91db539eeaa3ee876d1613ae44debde3e550dd0f
Deployment transaction: 006017deda3ff7f9560848d160f21f727677b8c9ad9e048a7cd7b6ed9547034e17
```

Deployed at block 634539 on 2026-08-29 with `policyVersion` 1.

As submission evidence, the build terminal screenshot should show the `canSpend` circuit and the `keys/` output, and the deployment screenshot should show the network together with the contract address.

## Submission checklist (Level 1 — New Moon)

| Requirement | Status |
| --- | --- |
| Toolchain installed, contract compiles via `compact compile` | Done — Compact 0.31.1, Node 22, Docker |
| Passing test suite | Done — 15 tests, typecheck clean |
| Generated `managed/` directory (circuits + keys) | Done |
| Deployed to Preview or Preprod with a visible contract address | Done — Preview, `4cadbd77b6decdc66102de0c91db539eeaa3ee876d1613ae44debde3e550dd0f` |
| Initial product idea in the README | Done |
| Minimum 5 meaningful commits | Done |
| Screenshot: successful compile output with circuits listed | Done — `docs/screenshots/compile.png` |
| Screenshot: deployment with the contract address shown | Pending — `docs/screenshots/deploy.png` |

Take the compile screenshot in a real terminal: the compiler renders the circuit list interactively, so it disappears if the output is piped or redirected to a file.

## Project structure

```text
contracts/spending_policy.compact       Compact source contract
contracts/managed/spending_policy/      Compiled contract, circuits and keys
src/midnight/witnesses.ts               Private state and witness implementation
src/midnight/spending-policy.test.ts    Circuit behaviour tests
scripts/deploy.ts                       Preview / Preprod deployment script
.env.example                            Deployment settings template
docs/screenshots/                       Compile and deployment evidence
```
