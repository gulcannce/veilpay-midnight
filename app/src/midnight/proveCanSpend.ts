/**
 * Runs the `canSpend` circuit and proves the resulting transaction.
 *
 * This is the first step that exercises the wallet's proving provider for real:
 * the circuit executes locally against the stored private state, and the
 * unproven transaction is handed to `proofProvider.proveTx`, which the ledger
 * fulfils by calling back into the wallet.
 *
 * It stops there. The proven transaction is never balanced and never submitted
 * — nothing reaches the chain, and no funds are touched. The private budget
 * stays in this browser: the circuit discloses only the boolean it returns.
 */
import { createUnprovenCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { spendingPolicy } from './contract';
import { PRIVATE_STATE_ID, type ReadOnlyProviders } from './providers';

/**
 * Byte sizes of the same call at three stages of proving.
 *
 * This is the evidence behind the privacy claim, measured rather than asserted.
 * `proven - erased` is the proof itself: the bytes that convince a verifier the
 * budget check passed. `erased` is what is left once those bytes are stripped —
 * the public transcript, which carries the price and the boolean and no trace of
 * the budget. A reader can compare the two numbers instead of taking our word.
 */
export type ProofSizes = {
  /** The call before the wallet proves anything. */
  readonly unprovenBytes: number;
  /** The same call once the wallet has attached a ZK proof. */
  readonly provenBytes: number;
  /** The call with proofs stripped back off — the public transcript alone. */
  readonly erasedBytes: number;
  /** `provenBytes - erasedBytes`: the weight of the proof. */
  readonly proofBytes: number;
};

export type ProofAttempt = {
  /** What the circuit decided, computed locally before any proving. */
  readonly canSpend: boolean;
  /** Whether the wallet produced a proof for the call. */
  readonly proved: boolean;
  /** Wall-clock cost of the proof, which is the interesting number here. */
  readonly provingMs: number;
  /**
   * Size evidence, or `null` when it could not be gathered.
   *
   * Measuring is secondary to proving: if a future ledger version renames
   * `serialize` or `eraseProofs`, the proof itself is still a real result and
   * the caller should still see it. The failure shows up as a missing panel,
   * not as a failed proof.
   */
  readonly sizes: ProofSizes | null;
};

/**
 * Measures a transaction at each proving stage.
 *
 * `proved !== undefined` is a weak test for "a proof happened" — it holds for
 * any object the provider returns. The byte delta is not weak: proofs are
 * kilobytes, and stripping them is a ledger operation that cannot be faked by
 * an empty stub.
 *
 * @param unproven The call as built locally.
 * @param proven The same call after the wallet proved it.
 */
const measure = (
  unproven: { serialize: () => Uint8Array },
  proven: { serialize: () => Uint8Array; eraseProofs: () => { serialize: () => Uint8Array } },
): ProofSizes | null => {
  try {
    const unprovenBytes = unproven.serialize().length;
    const provenBytes = proven.serialize().length;
    const erasedBytes = proven.eraseProofs().serialize().length;
    return {
      unprovenBytes,
      provenBytes,
      erasedBytes,
      proofBytes: provenBytes - erasedBytes,
    };
  } catch {
    return null;
  }
};

/**
 * @param providers The provider set for the connected wallet.
 * @param contractAddress The deployed spending policy.
 * @param price The amount to test against the private budget.
 */
export const proveCanSpend = async (
  providers: ReadOnlyProviders,
  contractAddress: string,
  price: bigint,
): Promise<ProofAttempt> => {
  providers.privateStateProvider.setContractAddress(contractAddress);

  const call = await createUnprovenCallTx(providers, {
    compiledContract: spendingPolicy,
    circuitId: 'canSpend',
    contractAddress,
    privateStateId: PRIVATE_STATE_ID,
    args: [price],
  });

  const startedAt = performance.now();
  const proven = await providers.proofProvider.proveTx(call.private.unprovenTx);
  const provingMs = Math.round(performance.now() - startedAt);

  return {
    canSpend: call.private.result,
    proved: proven !== undefined,
    provingMs,
    sizes: measure(
      call.private.unprovenTx as unknown as Parameters<typeof measure>[0],
      proven as unknown as Parameters<typeof measure>[1],
    ),
  };
};
