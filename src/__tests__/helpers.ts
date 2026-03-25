/**
 * Shared test helpers for ERC-8004 indexer integration tests.
 *
 * setupDb() runs the full migration DDL against the test D1 binding.
 * The migration SQL is inlined here to avoid ?raw import issues with
 * @cloudflare/vitest-pool-workers.
 */

// DDL mirrors migrations/0001_initial.sql exactly
const MIGRATION_DDL = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id         INTEGER PRIMARY KEY,
  owner            TEXT    NOT NULL,
  token_uri        TEXT,
  created_at_block INTEGER NOT NULL,
  created_at_tx    TEXT    NOT NULL,
  updated_at_block INTEGER
);

CREATE TABLE IF NOT EXISTS agent_metadata (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL,
  key          TEXT    NOT NULL,
  value_hex    TEXT    NOT NULL,
  value_len    INTEGER NOT NULL,
  set_at_block INTEGER NOT NULL,
  set_at_tx    TEXT    NOT NULL,
  UNIQUE (agent_id, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_metadata_agent_id
  ON agent_metadata (agent_id);

CREATE TABLE IF NOT EXISTS approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL,
  operator     TEXT    NOT NULL,
  approved     INTEGER NOT NULL,
  set_at_block INTEGER NOT NULL,
  set_at_tx    TEXT    NOT NULL,
  UNIQUE (agent_id, operator)
);

CREATE INDEX IF NOT EXISTS idx_approvals_agent_id
  ON approvals (agent_id);

CREATE TABLE IF NOT EXISTS feedback (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id         INTEGER NOT NULL,
  client           TEXT    NOT NULL,
  feedback_index   INTEGER NOT NULL,
  value            TEXT    NOT NULL,
  value_decimals   TEXT    NOT NULL,
  wad_value        TEXT    NOT NULL,
  tag1             TEXT    NOT NULL,
  tag2             TEXT    NOT NULL,
  endpoint         TEXT    NOT NULL,
  feedback_uri     TEXT    NOT NULL,
  feedback_hash    TEXT    NOT NULL,
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

CREATE TABLE IF NOT EXISTS client_approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL,
  client       TEXT    NOT NULL,
  index_limit  TEXT    NOT NULL,
  set_at_block INTEGER NOT NULL,
  set_at_tx    TEXT    NOT NULL,
  UNIQUE (agent_id, client)
);

CREATE INDEX IF NOT EXISTS idx_client_approvals_agent_id
  ON client_approvals (agent_id);

CREATE TABLE IF NOT EXISTS feedback_responses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id         INTEGER NOT NULL,
  client           TEXT    NOT NULL,
  feedback_index   INTEGER NOT NULL,
  responder        TEXT    NOT NULL,
  response_uri     TEXT    NOT NULL,
  response_hash    TEXT    NOT NULL,
  created_at_block INTEGER NOT NULL,
  created_at_tx    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_responses_agent_id
  ON feedback_responses (agent_id);

CREATE INDEX IF NOT EXISTS idx_feedback_responses_feedback
  ON feedback_responses (agent_id, client, feedback_index);

CREATE TABLE IF NOT EXISTS validation_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  request_hash       TEXT    NOT NULL UNIQUE,
  agent_id           INTEGER NOT NULL,
  validator          TEXT    NOT NULL,
  request_uri        TEXT    NOT NULL,
  has_response       INTEGER NOT NULL DEFAULT 0,
  response           TEXT,
  response_uri       TEXT,
  response_hash      TEXT,
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

CREATE TABLE IF NOT EXISTS sync_state (
  contract_id        TEXT    PRIMARY KEY,
  last_indexed_block INTEGER NOT NULL DEFAULT 0,
  last_indexed_tx    TEXT,
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Run the migration DDL against the test D1 binding.
 * Each statement is executed individually to work around miniflare's
 * lack of support for multi-statement exec() calls.
 */
export async function setupDb(db: D1Database): Promise<void> {
  // Split on semicolons, filter blanks and comment-only lines
  const statements = MIGRATION_DDL
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}
