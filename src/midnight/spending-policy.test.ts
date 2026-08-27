import { describe, expect, it } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { sampleCoinPublicKey } from '@midnight-ntwrk/ledger-v8';
import { Contract } from '../../contracts/managed/spending_policy/contract/index.js';

describe('VeilPay spending policy', () => {
  function createContract(budget: bigint) {
    return new Contract({
      getPrivateBudget: () => [{}, budget],
    });
  }

  function createContext(contract: Contract, policyVersion = 1n) {
    const initialState = contract.initialState(
      createConstructorContext({}, sampleCoinPublicKey()),
      policyVersion,
    );

    return createCircuitContext(
      dummyContractAddress(),
      initialState.currentZswapLocalState,
      initialState.currentContractState,
      initialState.currentPrivateState,
    );
  }

  it('allows spending when price is within the private budget', () => {
    const contract = createContract(100n);
    const context = createContext(contract);

    const result = contract.circuits.canSpend(context, 50n);

    expect(result.result).toBe(true);
  });

  it('rejects spending when price exceeds the private budget', () => {
    const contract = createContract(100n);
    const context = createContext(contract);

    const result = contract.circuits.canSpend(context, 150n);

    expect(result.result).toBe(false);
  });

  it('rejects spending when the public policy is inactive', () => {
    const contract = createContract(100n);
    const context = createContext(contract, 0n);

    const result = contract.circuits.canSpend(context, 50n);

    expect(result.result).toBe(false);
  });
});
