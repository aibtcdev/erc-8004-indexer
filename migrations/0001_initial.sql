-- ERC-8004 Indexer: Initial schema
-- All uint128/int128 (WAD) values stored as TEXT to avoid SQLite i64 overflow.
-- Boolean fields stored as INTEGER (0/1) per SQLite convention.

-- ============================================================
-- agents: registered agent identities (identity-registry-v2)
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
  agent_id         INTEGER PRIMARY KEY,  -- uint128 agent-id (NFT token-id)
  owner            TEXT    NOT NULL,      -- Stacks principal
  token_uri        TEXT,                  -- optional UTF-8 URI
  created_at_block INTEGER NOT NULL,
  created_at_tx    TEXT    NOT NULL,
  updated_at_block INTEGER               -- last update block (URI change, transfer)
);

-- ============================================================
-- agent_metadata: key/value metadata per agent
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_metadata (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL,
  key          TEXT    NOT NULL,          -- UTF-8 metadata key (max 128 chars)
  value_hex    TEXT    NOT NULL,          -- hex-encoded buffer value
  value_len    INTEGER NOT NULL,          -- byte length of value
  set_at_block INTEGER NOT NULL,
  set_at_tx    TEXT    NOT NULL,
  UNIQUE (agent_id, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_metadata_agent_id
  ON agent_metadata (agent_id);

-- ============================================================
-- approvals: approval-for-all operator grants
-- ============================================================
CREATE TABLE IF NOT EXISTS approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL,
  operator     TEXT    NOT NULL,          -- Stacks principal
  approved     INTEGER NOT NULL,          -- 1 = approved, 0 = revoked
  set_at_block INTEGER NOT NULL,
  set_at_tx    TEXT    NOT NULL,
  UNIQUE (agent_id, operator)
);

CREATE INDEX IF NOT EXISTS idx_approvals_agent_id
  ON approvals (agent_id);

-- ============================================================
-- feedback: reputation feedback entries (reputation-registry-v2)
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id         INTEGER NOT NULL,
  client           TEXT    NOT NULL,       -- Stacks principal (feedback giver)
  feedback_index   INTEGER NOT NULL,       -- per-client index from contract
  value            TEXT    NOT NULL,       -- int128 as TEXT (raw value)
  value_decimals   TEXT    NOT NULL,       -- uint128 as TEXT (decimal precision)
  wad_value        TEXT    NOT NULL,       -- int128 as TEXT (normalized to 18 dp)
  tag1             TEXT    NOT NULL,
  tag2             TEXT    NOT NULL,
  endpoint         TEXT    NOT NULL,
  feedback_uri     TEXT    NOT NULL,
  feedback_hash    TEXT    NOT NULL,       -- hex-encoded 32-byte hash
  is_revoked       INTEGER NOT NULL DEFAULT 0,
  created_at_block INTEGER NOT NULL,
  created_at_tx    TEXT    NOT NULL,
  revoked_at_block INTEGER,
  revoked_at_tx    TEXT,
  UNIQUE (agent_id, client, feedback_index)
);

CREATE INDEX IF NOT EXISTS idx_feedback_agent_id
  ON feedback (agent_id);

CREATE INDEX IF NOT EXISTS idx_feedback_client
  ON feedback (client);

CREATE INDEX IF NOT EXISTS idx_feedback_agent_client
  ON feedback (agent_id, client);

CREATE INDEX IF NOT EXISTS idx_feedback_is_revoked
  ON feedback (is_revoked);

-- ============================================================
-- client_approvals: approved client index limits per agent
-- ============================================================
CREATE TABLE IF NOT EXISTS client_approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL,
  client       TEXT    NOT NULL,         -- Stacks principal
  index_limit  TEXT    NOT NULL,         -- uint128 as TEXT
  set_at_block INTEGER NOT NULL,
  set_at_tx    TEXT    NOT NULL,
  UNIQUE (agent_id, client)
);

CREATE INDEX IF NOT EXISTS idx_client_approvals_agent_id
  ON client_approvals (agent_id);

-- ============================================================
-- feedback_responses: agent responses appended to feedback
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_responses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id         INTEGER NOT NULL,
  client           TEXT    NOT NULL,
  feedback_index   INTEGER NOT NULL,
  responder        TEXT    NOT NULL,     -- Stacks principal (agent or delegate)
  response_uri     TEXT    NOT NULL,
  response_hash    TEXT    NOT NULL,     -- hex-encoded 32-byte hash
  created_at_block INTEGER NOT NULL,
  created_at_tx    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_responses_agent_id
  ON feedback_responses (agent_id);

CREATE INDEX IF NOT EXISTS idx_feedback_responses_feedback
  ON feedback_responses (agent_id, client, feedback_index);

-- ============================================================
-- validation_requests: validation req/response pairs (validation-registry-v2)
-- ============================================================
CREATE TABLE IF NOT EXISTS validation_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  request_hash       TEXT    NOT NULL UNIQUE,  -- hex-encoded 32-byte hash (keyed in contract)
  agent_id           INTEGER NOT NULL,
  validator          TEXT    NOT NULL,          -- Stacks principal
  request_uri        TEXT    NOT NULL,
  has_response       INTEGER NOT NULL DEFAULT 0,
  response           TEXT,                      -- uint128 as TEXT (response score/enum)
  response_uri       TEXT,
  response_hash      TEXT,                      -- hex-encoded 32-byte hash
  tag                TEXT,
  created_at_block   INTEGER NOT NULL,
  created_at_tx      TEXT    NOT NULL,
  responded_at_block INTEGER,
  responded_at_tx    TEXT
);

CREATE INDEX IF NOT EXISTS idx_validation_requests_agent_id
  ON validation_requests (agent_id);

CREATE INDEX IF NOT EXISTS idx_validation_requests_validator
  ON validation_requests (validator);

-- ============================================================
-- sync_state: indexer sync cursor per contract
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_state (
  contract_id        TEXT    PRIMARY KEY,
  last_indexed_block INTEGER NOT NULL DEFAULT 0,
  last_indexed_tx    TEXT,
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- lenses: reputation lens registry (stub — populated in Phase 6)
-- ============================================================
CREATE TABLE IF NOT EXISTS lenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
