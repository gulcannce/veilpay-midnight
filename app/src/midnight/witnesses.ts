/**
 * Re-exports the contract's witnesses from the repo root.
 *
 * The witness implementation is shared with the deploy script and the contract
 * tests: it must stay a single definition, because a browser copy that drifted
 * would produce proofs the deployed verifier key rejects. This module exists
 * only so the import path lives in one place.
 */
export { createPrivateState, witnesses, type VeilPayPrivateState } from '../../../src/midnight/witnesses';
