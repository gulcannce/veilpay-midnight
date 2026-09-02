/**
 * Stage A verification: look up the deployed spending policy and confirm that
 * the artifacts in this repo describe the contract that is actually on chain.
 *
 * `findDeployedContract` reads the contract state through the indexer and
 * compares the verifier keys it finds there against the ones the ZK config
 * provider serves, so a successful call exercises the whole read path at once:
 * the wallet's indexer, the ZK artifact route, and the ledger WASM that decodes
 * the state. Nothing is proven, balanced, or submitted.
 */
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { spendingPolicy } from './contract';
import { PRIVATE_STATE_ID, type ReadOnlyProviders } from './providers';
import { createPrivateState } from './witnesses';

export type DeploymentFacts = {
  readonly contractAddress: string;
  readonly txId: string;
  readonly blockHeight: number;
  readonly blockHash: string;
};

/**
 * @param providers The read-only provider set for the connected wallet.
 * @param contractAddress The address recorded by the Level 1 deployment.
 * @returns The public, non-sensitive half of the deploy transaction data.
 */
export const verifyDeployment = async (
  providers: ReadOnlyProviders,
  contractAddress: string,
): Promise<DeploymentFacts> => {
  // `findDeployedContract` needs private state to exist before it can build the
  // call interface, and this browser has none: the Level 1 budget was chosen on
  // the machine that deployed the contract and never left it. Seed a zero
  // budget on the first run only — zero denies every spend, so a placeholder
  // that is mistaken for a real budget fails closed. An existing state is left
  // untouched, since the overload that takes an initial state overwrites it.
  // The store namespaces private state per contract, and reads throw until it
  // has been told which one we mean.
  providers.privateStateProvider.setContractAddress(contractAddress);
  const existingPrivateState = await providers.privateStateProvider.get(PRIVATE_STATE_ID);
  const found =
    existingPrivateState === null
      ? await findDeployedContract(providers, {
          compiledContract: spendingPolicy,
          contractAddress,
          privateStateId: PRIVATE_STATE_ID,
          initialPrivateState: createPrivateState(0n),
        })
      : await findDeployedContract(providers, {
          compiledContract: spendingPolicy,
          contractAddress,
          privateStateId: PRIVATE_STATE_ID,
        });

  // `deployTxData` transitively carries the signing key and the initial private
  // state; only the fields the chain already publishes are pulled out here.
  const { txId, blockHeight, blockHash } = found.deployTxData.public;
  return { contractAddress, txId, blockHeight, blockHash };
};
