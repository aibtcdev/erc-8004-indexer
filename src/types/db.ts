/**
 * Database row types for ERC-8004 Indexer D1 schema.
 * All uint128/int128 (WAD) values are stored as TEXT in SQLite to avoid i64 overflow.
 * Boolean fields use number (0 | 1) per SQLite convention.
 */

/**
 * Row from the `agents` table.
 * Represents a registered agent identity from identity-registry-v2.
 */
export interface AgentRow {
  agent_id: number;
  owner: string;
  token_uri: string | null;
  created_at_block: number;
  created_at_tx: string;
  updated_at_block: number | null;
}

/**
 * Row from the `agent_metadata` table.
 * Represents a key/value metadata entry for an agent.
 */
export interface AgentMetadataRow {
  id: number;
  agent_id: number;
  key: string;
  value_hex: string;
  value_len: number;
  set_at_block: number;
  set_at_tx: string;
}

/**
 * Row from the `approvals` table.
 * Represents an approval-for-all grant from an agent to an operator.
 */
export interface ApprovalRow {
  id: number;
  agent_id: number;
  operator: string;
  /** 1 = approved, 0 = revoked */
  approved: number;
  set_at_block: number;
  set_at_tx: string;
}

/**
 * Row from the `feedback` table.
 * Represents a reputation feedback entry from reputation-registry-v2.
 * WAD values (value, wad_value) and value_decimals are stored as TEXT.
 */
export interface FeedbackRow {
  id: number;
  agent_id: number;
  client: string;
  feedback_index: number;
  /** int128 as TEXT — raw feedback value */
  value: string;
  /** uint128 as TEXT — decimal precision of raw value */
  value_decimals: string;
  /** int128 as TEXT — value normalized to 18 decimal places (WAD) */
  wad_value: string;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedback_uri: string;
  /** hex-encoded 32-byte hash */
  feedback_hash: string;
  /** 1 = revoked, 0 = active */
  is_revoked: number;
  created_at_block: number;
  created_at_tx: string;
  revoked_at_block: number | null;
  revoked_at_tx: string | null;
}

/**
 * Row from the `client_approvals` table.
 * Represents an approved client's feedback index limit for an agent.
 */
export interface ClientApprovalRow {
  id: number;
  agent_id: number;
  client: string;
  /** uint128 as TEXT — maximum feedback index this client may submit */
  index_limit: string;
  set_at_block: number;
  set_at_tx: string;
}

/**
 * Row from the `feedback_responses` table.
 * Represents an agent's response appended to a feedback entry.
 */
export interface FeedbackResponseRow {
  id: number;
  agent_id: number;
  client: string;
  feedback_index: number;
  responder: string;
  response_uri: string;
  /** hex-encoded 32-byte hash */
  response_hash: string;
  created_at_block: number;
  created_at_tx: string;
}

/**
 * Row from the `validation_requests` table.
 * Represents a validation request/response pair from validation-registry-v2.
 */
export interface ValidationRequestRow {
  id: number;
  /** hex-encoded 32-byte hash — primary key in contract */
  request_hash: string;
  agent_id: number;
  validator: string;
  request_uri: string;
  /** 1 = has response, 0 = pending */
  has_response: number;
  /** uint128 as TEXT — response score/enum value (null until responded) */
  response: string | null;
  response_uri: string | null;
  /** hex-encoded 32-byte hash (null until responded) */
  response_hash: string | null;
  tag: string | null;
  created_at_block: number;
  created_at_tx: string;
  responded_at_block: number | null;
  responded_at_tx: string | null;
}

/**
 * Row from the `sync_state` table.
 * Tracks the last indexed block per contract for gap detection.
 */
export interface SyncStateRow {
  contract_id: string;
  last_indexed_block: number;
  last_indexed_tx: string | null;
  updated_at: string;
}

/**
 * Row from the `blocks_seen` table.
 * Audit log of every block the indexer has processed.
 * is_canonical: 1 = on the canonical chain, 0 = non-canonical (forked/orphaned).
 */
export interface BlockSeenRow {
  block_height: number;
  block_hash: string;
  /** 1 = canonical, 0 = non-canonical */
  is_canonical: number;
  indexed_at: string;
}

/**
 * Row from the `lenses` table.
 * Registry of named reputation lens aggregations with full configuration.
 */
export interface LensRow {
  id: number;
  name: string;
  description: string | null;
  /** JSON-encoded LensConfig */
  config: string;
  created_at: string;
}
