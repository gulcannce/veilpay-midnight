/**
 * The compiled spending policy, assembled for the browser.
 *
 * Both halves come from the repo root rather than a copy under `app/`: the
 * contract module is `compact compile` output, and the witnesses are shared
 * with the deploy script. A duplicate of either could drift from the verifier
 * key that is already on chain.
 */
import { pipe } from 'effect';
import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { Contract } from '../../../contracts/managed/spending_policy/contract/index.js';
import { witnesses } from './witnesses';

/**
 * Path to the compiled assets, relative to whatever base the consuming service
 * uses. In the browser that service is `FetchZkConfigProvider`, whose base URL
 * already points at the artifact root, so there is nothing left to prepend.
 */
const COMPILED_ASSETS_PATH = '';

export const spendingPolicy = pipe(
  CompiledContract.make('spending_policy', Contract),
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(COMPILED_ASSETS_PATH),
);
