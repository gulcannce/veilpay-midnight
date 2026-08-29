import { describe, expect, it } from 'vitest';
import {
  CompactError,
  CompactTypeBoolean,
  CompactTypeUnsignedInteger,
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { sampleCoinPublicKey } from '@midnight-ntwrk/ledger-v8';
import { Contract, ledger } from '../../contracts/managed/spending_policy/contract/index.js';
import { createPrivateState, witnesses, type VeilPayPrivateState } from './witnesses.js';

const UINT64_MAX = 2n ** 64n - 1n;

// Mirrors the descriptor the compiler emitted for Uint<64> (see _descriptor_0 in
// contracts/managed/spending_policy/contract/index.js), so these tests encode and
// decode values exactly the way the circuit does.
const uint64 = new CompactTypeUnsignedInteger(UINT64_MAX, 8);

// fromValue consumes the array it is handed, so always decode from a copy.
const decodeUint64 = (aligned: { value: Uint8Array[] }): bigint =>
  uint64.fromValue([...aligned.value]);

const decodeBoolean = (aligned: { value: Uint8Array[] }): boolean =>
  CompactTypeBoolean.fromValue([...aligned.value]);

/**
 * Concatenates every byte string reachable from a proof-data fragment. The
 * public transcript is a heterogeneous list of ops, so walking it structurally
 * is the only way to be sure no encoded value hides in a nested field.
 */
const dumpBytes = (node: unknown): string => {
  const chunks: string[] = [];
  const walk = (value: unknown): void => {
    if (value instanceof Uint8Array) {
      chunks.push(Buffer.from(value).toString('hex'));
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value instanceof Map) {
      value.forEach((entryValue, entryKey) => {
        walk(entryKey);
        walk(entryValue);
      });
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(node);
  return chunks.join('|');
};

const encodedHex = (value: bigint): string => dumpBytes(uint64.toValue(value));

const createHarness = (budget: bigint, policyVersion = 1n) => {
  const contract = new Contract<VeilPayPrivateState>(witnesses);
  const initialState = contract.initialState(
    createConstructorContext(createPrivateState(budget), sampleCoinPublicKey()),
    policyVersion,
  );

  return {
    contract,
    initialState,
    context: createCircuitContext(
      dummyContractAddress(),
      initialState.currentZswapLocalState,
      initialState.currentContractState,
      initialState.currentPrivateState,
    ),
  };
};

describe('VeilPay spending policy', () => {
  it('allows spending when price is within the private budget', () => {
    const { contract, context } = createHarness(100n);

    const result = contract.circuits.canSpend(context, 50n);

    expect(result.result).toBe(true);
  });

  it('rejects spending when price exceeds the private budget', () => {
    const { contract, context } = createHarness(100n);

    const result = contract.circuits.canSpend(context, 150n);

    expect(result.result).toBe(false);
  });

  it('rejects spending when the public policy is inactive', () => {
    const { contract, context } = createHarness(100n, 0n);

    const result = contract.circuits.canSpend(context, 50n);

    expect(result.result).toBe(false);
  });

  describe('budget boundaries', () => {
    it('allows a price exactly equal to the budget', () => {
      const { contract, context } = createHarness(100n);

      expect(contract.circuits.canSpend(context, 100n).result).toBe(true);
    });

    it('rejects a price one unit above the budget', () => {
      const { contract, context } = createHarness(100n);

      expect(contract.circuits.canSpend(context, 101n).result).toBe(false);
    });

    it('allows a zero price against a zero budget', () => {
      const { contract, context } = createHarness(0n);

      expect(contract.circuits.canSpend(context, 0n).result).toBe(true);
    });

    it('rejects any positive price against a zero budget', () => {
      const { contract, context } = createHarness(0n);

      expect(contract.circuits.canSpend(context, 1n).result).toBe(false);
    });
  });

  describe('policy version', () => {
    it('records the constructor argument in the public ledger', () => {
      const { initialState } = createHarness(100n, 7n);

      expect(ledger(initialState.currentContractState.data).policyVersion).toBe(7n);
    });

    it('treats any version at or above 1 as active', () => {
      const { contract, context } = createHarness(100n, 7n);

      expect(contract.circuits.canSpend(context, 50n).result).toBe(true);
    });

    it('treats the maximum version as active', () => {
      const { contract, context } = createHarness(100n, UINT64_MAX);

      expect(contract.circuits.canSpend(context, 50n).result).toBe(true);
    });
  });

  describe('Uint<64> bounds', () => {
    it('accepts the largest representable price and budget', () => {
      const { contract, context } = createHarness(UINT64_MAX);

      expect(contract.circuits.canSpend(context, UINT64_MAX).result).toBe(true);
    });

    it('rejects a price that does not fit in Uint<64>', () => {
      const { contract, context } = createHarness(UINT64_MAX);

      expect(() => contract.circuits.canSpend(context, UINT64_MAX + 1n)).toThrow(CompactError);
    });

    it('rejects a witness that returns a budget outside Uint<64>', () => {
      const contract = new Contract<VeilPayPrivateState>({
        getPrivateBudget: ({ privateState }) => [privateState, UINT64_MAX + 1n],
      });
      const initialState = contract.initialState(
        createConstructorContext(createPrivateState(0n), sampleCoinPublicKey()),
        1n,
      );
      const context = createCircuitContext(
        dummyContractAddress(),
        initialState.currentZswapLocalState,
        initialState.currentContractState,
        initialState.currentPrivateState,
      );

      expect(() => contract.circuits.canSpend(context, 1n)).toThrow(/getPrivateBudget/);
    });
  });

  describe('disclosure surface', () => {
    // A value whose 8-byte encoding is distinctive enough that an accidental
    // match against unrelated transcript bytes is implausible.
    const BUDGET = 123456789012345n;
    const PRICE = 50n;

    it('confines the private budget to the private transcript', () => {
      const { contract, initialState, context } = createHarness(BUDGET);
      const stateBefore = initialState.currentContractState.data.toString();

      const { result, proofData, context: after } = contract.circuits.canSpend(context, PRICE);
      const budgetHex = encodedHex(BUDGET);

      // Positive control: the walker and the encoding agree, so the negative
      // assertions below are capable of failing if the budget ever leaks.
      expect(proofData.privateTranscriptOutputs).toHaveLength(1);
      expect(dumpBytes(proofData.privateTranscriptOutputs)).toContain(budgetHex);
      expect(decodeUint64(proofData.privateTranscriptOutputs[0]!)).toBe(BUDGET);

      // The public input is the price alone; the public output is the verdict.
      expect(decodeUint64(proofData.input)).toBe(PRICE);
      expect(decodeBoolean(proofData.output)).toBe(result);
      expect(result).toBe(true);

      // The transcript must carry the policyVersion read, and nothing else that
      // would let an observer recover the budget.
      // Guard the guard: an empty dump would make the checks below vacuous.
      expect(proofData.publicTranscript.length).toBeGreaterThan(0);
      expect(dumpBytes(proofData.publicTranscript).length).toBeGreaterThan(0);
      expect(dumpBytes(proofData.input)).not.toContain(budgetHex);
      expect(dumpBytes(proofData.output)).not.toContain(budgetHex);
      expect(dumpBytes(proofData.publicTranscript)).not.toContain(budgetHex);

      // canSpend only reads the ledger, so the public state must be untouched.
      expect(after.currentQueryContext.state.toString()).toBe(stateBefore);
      expect(ledger(after.currentQueryContext.state).policyVersion).toBe(1n);
      expect(dumpBytes(after.currentQueryContext.state.state)).not.toContain(budgetHex);
    });

    it('produces the same public transcript for two different budgets', () => {
      const cheap = createHarness(BUDGET);
      const rich = createHarness(BUDGET * 2n);

      const cheapRun = cheap.contract.circuits.canSpend(cheap.context, PRICE);
      const richRun = rich.contract.circuits.canSpend(rich.context, PRICE);

      // Both runs approve the same price, so nothing public may distinguish them.
      expect(cheapRun.result).toBe(true);
      expect(richRun.result).toBe(true);
      expect(dumpBytes(cheapRun.proofData.publicTranscript).length).toBeGreaterThan(0);
      expect(dumpBytes(richRun.proofData.publicTranscript)).toBe(
        dumpBytes(cheapRun.proofData.publicTranscript),
      );
      expect(dumpBytes(richRun.proofData.input)).toBe(dumpBytes(cheapRun.proofData.input));
      expect(dumpBytes(richRun.proofData.output)).toBe(dumpBytes(cheapRun.proofData.output));

      // ...while the private transcripts genuinely differ.
      expect(dumpBytes(richRun.proofData.privateTranscriptOutputs)).not.toBe(
        dumpBytes(cheapRun.proofData.privateTranscriptOutputs),
      );
    });
  });
});
