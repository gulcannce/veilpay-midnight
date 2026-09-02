/**
 * Preview network facts.
 *
 * These are reference values, not the source of truth at runtime: a connected
 * wallet reports its own service URLs via `getConfiguration()`, and the wallet
 * user may have deliberately pointed it elsewhere. We compare against these to
 * detect a network mismatch, and fall back to them only when displaying what we
 * expect.
 */
export const EXPECTED_NETWORK_ID = 'preview';

export const PREVIEW_REFERENCE = {
  networkId: EXPECTED_NETWORK_ID,
  indexerUri: 'https://indexer.preview.midnight.network/api/v4/graphql',
  indexerWsUri: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  substrateNodeUri: 'https://rpc.preview.midnight.network',
} as const;

/** The deployed Level 1 spending policy. Read-only here; nothing calls it yet. */
export const SPENDING_POLICY_CONTRACT_ADDRESS =
  '4cadbd77b6decdc66102de0c91db539eeaa3ee876d1613ae44debde3e550dd0f';
