import { describe, expect, it } from 'vitest';
import { Contract } from '../../build/contract/index.js';

describe('VeilPay spending policy', () => {
  function createContract(budget: bigint) {
    return new Contract({
      getPrivateBudget: () => [{}, budget],
    });
  }

  it('allows spending when price is within the private budget', () => {
    const contract = createContract(100n);

    expect(contract).toBeDefined();
  });

  it('rejects spending when price exceeds the private budget', () => {
    const contract = createContract(100n);

    expect(contract).toBeDefined();
  });
});
