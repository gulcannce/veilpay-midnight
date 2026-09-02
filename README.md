# VeilPay

VeilPay is a payment policy on Midnight that checks purchases against a private budget. A user proves that a purchase amount is allowed without revealing the budget itself; the merchant and the chain only learn that a policy is active and that the spend was approved or rejected.

## Current status

**Level 1 — complete and verified.**

- The Compact contract compiles with Compact 0.31.1, producing the managed contract, the `canSpend` circuit IR, and prover/verifier keys.
- **15 passing tests** (`npm test`) and a **clean TypeScript typecheck** (`npm run typecheck`). These drive the compiled contract through the Midnight JavaScript runtime (`@midnight-ntwrk/compact-runtime` 0.16.0), which executes the circuit logic and records proof data without building a zero-knowledge proof.
- Privacy is asserted structurally, by inspecting the `ProofData` surfaces the runtime emits rather than by inspecting the ledger alone. See [Public state vs. private witness](#public-state-vs-private-witness).
- Deployed to **Preview** at `4cadbd77b6decdc66102de0c91db539eeaa3ee876d1613ae44debde3e550dd0f`, block 634539.

**Level 2 — the frontend in [`app/`](app/README.md).**

- Connects the Lace wallet, looks the deployed contract up through the wallet's own indexer, and confirms the on-chain verifier key matches the one compiled here.
- Runs `canSpend` from the browser and has the **wallet** prove it — `getProvingProvider()` supplies a ledger-shaped prover, so no local proof server is involved. Verified end to end in a real browser against real Lace.
- Reports the [observable privacy behaviour](#the-privacy-claim-and-how-to-observe-it) as measured byte counts rather than as a claim.
- Balancing and submission stay deliberately unwired: the proof is built and measured, and nothing reaches the chain.

**Not done yet:**

- **No merchant side and no settlement.** `canSpend()` is a policy primitive, not yet a payment.
- **No hosted demo.** The frontend runs locally.

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

## The privacy claim, and how to observe it

**The claim.** A user proves a purchase fits a budget without revealing the budget, the remaining balance, or the spending history. The only thing released is one boolean.

That is a claim about what is *absent* from the transaction, which is exactly the kind of claim a demo tends to assert rather than show. The frontend makes it observable by measuring the same call at three stages of proving and printing the byte counts:

| Stage | What it is |
| --- | --- |
| Unproven call | The circuit call as built locally, before the wallet proves anything |
| Proven call | The same call once the wallet has attached a zero-knowledge proof |
| Public transcript | The proven call with `eraseProofs()` applied — what is left once the proof is stripped |

Measured against the live Preview contract with real Lace:

```text
unproven          493 bytes
proven           3304 bytes
proofs erased     382 bytes
→ proof itself   2922 bytes
```

The 2,922 bytes of proof are what convince a verifier the budget check passed. The 382-byte public transcript that remains after erasing them carries the price and the boolean and nothing else — no budget, and no value derived from it. Change the private budget and re-run: the boolean flips, and these shapes do not.

Two details make this evidence rather than decoration. The proof is produced by the wallet's own `getProvingProvider()`, so its size is not something this repository controls. And `eraseProofs()` is a ledger operation on a real transaction — an empty stub could return `undefined` and satisfy a `proved !== undefined` check, but it could not produce a 3,304-byte transaction that shrinks to 382 bytes when its proofs are removed.

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
| `VEILPAY_CHECKPOINT_MS` | no | `300000` | How often sync progress is saved; `0` disables it |
| `VEILPAY_CHECKPOINT_DIR` | no | `.states` | Where checkpoints are written |
| `VEILPAY_SYNC_ONLY` | no | — | `1` syncs and checkpoints, then stops without deploying |

The wallet seed is a secret. `.env` is gitignored (only `.env.example` is tracked) — never commit a real seed.

A fresh seed scans the chain from genesis, which takes roughly 20-30 minutes on Preview; the script prints progress every fifteen seconds. If the wallet holds no NIGHT, the script then requests tokens from the network faucet and registers the received UTXOs for dust generation before deploying. On success it prints the deployment details and writes them to `deployment.<network>.json`. The deployed instance:

```text
Network: preview
Contract address: 4cadbd77b6decdc66102de0c91db539eeaa3ee876d1613ae44debde3e550dd0f
Deployment transaction: 006017deda3ff7f9560848d160f21f727677b8c9ad9e048a7cd7b6ed9547034e17
```

Deployed at block 634539 on 2026-08-29 with `policyVersion` 1.

### Resumable sync

Preprod is a different proposition from Preview: its dust chain is roughly 1.5M events against Preview's 166K, so the initial scan runs for hours rather than half an hour. A wallet built the ordinary way starts that scan from genesis *every time it starts*, which makes any interruption — a closed laptop, a Ctrl-C, a network drop — cost the whole run.

`scripts/walletCheckpoint.ts` removes that cliff. Each of the three wallets exposes `serializeState()`, each wallet class exposes `restore()`, and testkit's `MidnightWalletProvider.withWallet` accepts an externally assembled facade; joining those lets the deploy script write its sync position to `.states/` as it goes and pick up from there next time. Progress is saved on a timer, once more when the sync completes, and again on `SIGINT`/`SIGTERM` before exiting.

Because syncing is the expensive half and deploying is the irreversible one, the two can be separated:

```bash
VEILPAY_NETWORK=preprod VEILPAY_SYNC_ONLY=1 npm run deploy   # hours, resumable, deploys nothing
VEILPAY_NETWORK=preprod npm run deploy                       # starts from the checkpoint
```

A checkpoint is ignored — and the sync restarts from genesis — when it was written for a different network, by a different wallet seed, or in an older format. Checkpoints hold chain state, never the seed; `.states/` is gitignored.

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
| Screenshot: deployment with the contract address shown | Done — `docs/screenshots/deploy.png` |

Take the compile screenshot in a real terminal: the compiler renders the circuit list interactively, so it disappears if the output is piped or redirected to a file.

## Submission checklist (Level 2 — Waxing Crescent)

| Requirement | Status |
| --- | --- |
| Lace wallet connect / disconnect implemented | Done — connect via `connect(networkId)`; the connector API has no `disconnect`, so the UI offers "End session here" and says plainly what it does and does not revoke |
| Circuit called successfully from the frontend | Done — `canSpend` runs in the browser and the wallet proves it |
| An observable privacy behaviour | Done — [measured byte counts](#the-privacy-claim-and-how-to-observe-it) separating the proof from the public transcript |
| Contract deployed to Preprod with a verifiable address | In progress — Preview is live; the Preprod sync is what [resumable sync](#resumable-sync) exists to make survivable |
| Public GitHub repository with README | Done |
| README documenting the privacy claim | Done |
| Live demo link | Not done |
| Demo video: wallet connect + a successful circuit call | Not done |
| Minimum 8 meaningful commits | Done |

## Project structure

```text
contracts/spending_policy.compact       Compact source contract
contracts/managed/spending_policy/      Compiled contract, circuits and keys
src/midnight/witnesses.ts               Private state and witness implementation
src/midnight/spending-policy.test.ts    Circuit behaviour tests
scripts/deploy.ts                       Preview / Preprod deployment script
scripts/walletCheckpoint.ts             Resumable wallet sync for long Preprod scans
app/                                    Level 2 frontend (Vite + React) — see app/README.md
.env.example                            Deployment settings template
docs/screenshots/                       Compile and deployment evidence
```
