import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../../contracts/managed/spending_policy/contract/index.js';

/**
 * Local-only state for the spending policy. The budget lives on the user's
 * device and is never written to the ledger or sent to the network.
 */
export type VeilPayPrivateState = {
  readonly budget: bigint;
};

export const createPrivateState = (budget: bigint): VeilPayPrivateState => ({ budget });

export const witnesses = {
  getPrivateBudget: ({
    privateState,
  }: WitnessContext<Ledger, VeilPayPrivateState>): [VeilPayPrivateState, bigint] => [
    privateState,
    privateState.budget,
  ],
};
