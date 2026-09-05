/**
 * Preprod network facts.
 *
 * These are reference values, not the source of truth at runtime: a connected
 * wallet reports its own service URLs via `getConfiguration()`, and the wallet
 * user may have deliberately pointed it elsewhere. We compare against these to
 * detect a network mismatch, and fall back to them only when displaying what we
 * expect.
 *
 * Level 2 requires Preprod — the task page asks for Lace connected on Preprod
 * and a contract deployed there — so this is the network the app targets. The
 * Preview deployment still exists at
 * 4cadbd77b6decdc66102de0c91db539eeaa3ee876d1613ae44debde3e550dd0f; it is kept
 * out of the code to avoid two addresses that look interchangeable but are not.
 */
export const EXPECTED_NETWORK_ID = 'preprod';

export const PREPROD_REFERENCE = {
  networkId: EXPECTED_NETWORK_ID,
  indexerUri: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWsUri: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  substrateNodeUri: 'https://rpc.preprod.midnight.network',
} as const;

/**
 * The deployed spending policy, from `deployment.preprod.json`.
 *
 * Deployed in block 2402474. Three identifiers name that one deployment, each
 * produced by a different system, and they do not match each other:
 *
 * - **Deployment identifier** —
 *   `009631b3cf6e281a30cec8cf2a71cb3c58adf49cfdb18edb8537e52571abaae545`.
 *   Written by `scripts/deploy.ts` from `deployTxData.public.txId` at deploy
 *   time, and stored as `deploymentTransaction` in `deployment.preprod.json`.
 * - **Indexer txId** —
 *   `0010f41493858da58047312d65d01b06540d12b3faf28fafb7d2f7ba2c127074a2`.
 *   What the wallet's indexer returns for the same field when
 *   `findDeployedContract` looks the contract up, and what this app displays.
 * - **Explorer transaction hash** —
 *   `ea8969e7cb03a54799ecf43ea5987e1c2f26f1d4d0a35047536a84cffec08290`.
 *   What the block explorer shows for the deployment.
 *
 * Why they differ has not been established, so none of them should be quoted
 * as "the" transaction id. The contract address below and block height 2402474
 * agree across all three sources; identify the deployment by those.
 */
export const SPENDING_POLICY_CONTRACT_ADDRESS =
  '929883d2a7d3bab4656315bb13a1c38fc5ca1bf7173ec33db41252f83c55e663';
