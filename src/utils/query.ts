/**
 * D1 query builders for ERC-8004 Indexer.
 *
 * All queries use parameterized prepare().bind() calls.
 * All uint128/int128 values are stored as TEXT in SQLite.
 */

import type {
  AgentRow,
  AgentMetadataRow,
  BlockSeenRow,
  ClientApprovalRow,
  FeedbackRow,
  FeedbackResponseRow,
  ValidationRequestRow,
  SyncStateRow,
  LensRow,
} from "../types/db";

// ============================================================
// Shared query helpers
// ============================================================

interface WhereClause {
  sql: string;
  bindings: (string | number)[];
}

/**
 * Build a WHERE clause from an initial condition and optional filter fields.
 * Filters with undefined values are skipped.
 */
function buildWhereClause(
  initial: { sql: string; value: string | number },
  filters: Record<string, string | number | boolean | undefined>
): WhereClause {
  const conditions = [initial.sql];
  const bindings: (string | number)[] = [initial.value];

  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    conditions.push(`${column} = ?`);
    bindings.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }

  return { sql: conditions.join(" AND "), bindings };
}

// ============================================================
// Agents
// ============================================================

export async function queryAgents(
  db: D1Database,
  { limit, offset }: { limit: number; offset: number }
): Promise<{ rows: AgentRow[]; total: number }> {
  const [countResult, rowsResult] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total FROM agents").first<{ total: number }>(),
    db
      .prepare("SELECT * FROM agents ORDER BY agent_id ASC LIMIT ? OFFSET ?")
      .bind(limit, offset)
      .all<AgentRow>(),
  ]);

  return {
    rows: rowsResult.results ?? [],
    total: countResult?.total ?? 0,
  };
}

export async function queryAgentById(
  db: D1Database,
  agentId: number
): Promise<AgentRow | null> {
  return db
    .prepare("SELECT * FROM agents WHERE agent_id = ?")
    .bind(agentId)
    .first<AgentRow>();
}

export async function queryAgentMetadata(
  db: D1Database,
  agentId: number
): Promise<AgentMetadataRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM agent_metadata WHERE agent_id = ? ORDER BY key ASC"
    )
    .bind(agentId)
    .all<AgentMetadataRow>();
  return result.results ?? [];
}

// ============================================================
// Feedback summary
// ============================================================

export interface FeedbackSummary {
  total_count: number;
  active_count: number;
  revoked_count: number;
  /** Sum of wad_value for active (non-revoked) entries, as a decimal string */
  wad_sum: string;
}

export interface FeedbackFilters {
  client?: string;
  tag1?: string;
  tag2?: string;
}

export async function queryFeedbackSummary(
  db: D1Database,
  agentId: number,
  filters: FeedbackFilters = {}
): Promise<FeedbackSummary> {
  const { sql: where, bindings } = buildWhereClause(
    { sql: "agent_id = ?", value: agentId },
    { client: filters.client, tag1: filters.tag1, tag2: filters.tag2 }
  );

  // Aggregate counts
  const countRow = await db
    .prepare(
      `SELECT
         COUNT(*) AS total_count,
         SUM(CASE WHEN is_revoked = 0 THEN 1 ELSE 0 END) AS active_count,
         SUM(CASE WHEN is_revoked = 1 THEN 1 ELSE 0 END) AS revoked_count
       FROM feedback
       WHERE ${where}`
    )
    .bind(...bindings)
    .first<{ total_count: number; active_count: number; revoked_count: number }>();

  // Fetch wad_value strings for active entries to sum in JS (avoids i64 overflow)
  const wadRows = await db
    .prepare(
      `SELECT wad_value FROM feedback WHERE ${where} AND is_revoked = 0`
    )
    .bind(...bindings)
    .all<{ wad_value: string }>();

  // Sum wad_values using BigInt to handle large uint128 values
  let wadSum = BigInt(0);
  for (const row of wadRows.results ?? []) {
    try {
      wadSum += BigInt(row.wad_value);
    } catch {
      // Skip invalid values
    }
  }

  return {
    total_count: countRow?.total_count ?? 0,
    active_count: countRow?.active_count ?? 0,
    revoked_count: countRow?.revoked_count ?? 0,
    wad_sum: wadSum.toString(),
  };
}

// ============================================================
// Feedback list
// ============================================================

export async function queryFeedback(
  db: D1Database,
  agentId: number,
  {
    limit,
    offset,
    client,
    tag1,
    tag2,
  }: { limit: number; offset: number } & FeedbackFilters
): Promise<{ rows: FeedbackRow[]; total: number }> {
  const { sql: where, bindings } = buildWhereClause(
    { sql: "agent_id = ?", value: agentId },
    { client, tag1, tag2 }
  );

  const [countResult, rowsResult] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM feedback WHERE ${where}`)
      .bind(...bindings)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT * FROM feedback WHERE ${where}
         ORDER BY created_at_block DESC, feedback_index ASC
         LIMIT ? OFFSET ?`
      )
      .bind(...bindings, limit, offset)
      .all<FeedbackRow>(),
  ]);

  return {
    rows: rowsResult.results ?? [],
    total: countResult?.total ?? 0,
  };
}

export async function queryFeedbackBySeq(
  db: D1Database,
  agentId: number,
  feedbackIndex: number
): Promise<FeedbackRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM feedback WHERE agent_id = ? AND feedback_index = ? ORDER BY client ASC"
    )
    .bind(agentId, feedbackIndex)
    .all<FeedbackRow>();
  return result.results ?? [];
}

// ============================================================
// Client approvals
// ============================================================

export async function queryClients(
  db: D1Database,
  agentId: number
): Promise<ClientApprovalRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM client_approvals WHERE agent_id = ? ORDER BY client ASC"
    )
    .bind(agentId)
    .all<ClientApprovalRow>();
  return result.results ?? [];
}

// ============================================================
// Feedback responses
// ============================================================

export async function queryFeedbackResponses(
  db: D1Database,
  agentId: number,
  client: string,
  feedbackIndex: number
): Promise<FeedbackResponseRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM feedback_responses
       WHERE agent_id = ? AND client = ? AND feedback_index = ?
       ORDER BY created_at_block ASC`
    )
    .bind(agentId, client, feedbackIndex)
    .all<FeedbackResponseRow>();
  return result.results ?? [];
}

// ============================================================
// Recent feedback (global)
// ============================================================

export async function queryRecentFeedback(
  db: D1Database,
  { limit, offset }: { limit: number; offset: number }
): Promise<{ rows: FeedbackRow[]; total: number }> {
  const [countResult, rowsResult] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS total FROM feedback")
      .first<{ total: number }>(),
    db
      .prepare(
        "SELECT * FROM feedback ORDER BY created_at_block DESC, id DESC LIMIT ? OFFSET ?"
      )
      .bind(limit, offset)
      .all<FeedbackRow>(),
  ]);

  return {
    rows: rowsResult.results ?? [],
    total: countResult?.total ?? 0,
  };
}

// ============================================================
// Validations
// ============================================================

export interface ValidationSummary {
  total: number;
  pending: number;
  responded: number;
}

export async function queryValidationSummary(
  db: D1Database,
  agentId: number
): Promise<ValidationSummary> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN has_response = 0 THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN has_response = 1 THEN 1 ELSE 0 END) AS responded
       FROM validation_requests
       WHERE agent_id = ?`
    )
    .bind(agentId)
    .first<{ total: number; pending: number; responded: number }>();

  return {
    total: row?.total ?? 0,
    pending: row?.pending ?? 0,
    responded: row?.responded ?? 0,
  };
}

export async function queryValidations(
  db: D1Database,
  agentId: number,
  {
    limit,
    offset,
    has_response,
  }: { limit: number; offset: number; has_response?: boolean }
): Promise<{ rows: ValidationRequestRow[]; total: number }> {
  const { sql: where, bindings } = buildWhereClause(
    { sql: "agent_id = ?", value: agentId },
    { has_response }
  );

  const [countResult, rowsResult] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM validation_requests WHERE ${where}`)
      .bind(...bindings)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT * FROM validation_requests WHERE ${where}
         ORDER BY created_at_block DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...bindings, limit, offset)
      .all<ValidationRequestRow>(),
  ]);

  return {
    rows: rowsResult.results ?? [],
    total: countResult?.total ?? 0,
  };
}

export async function queryValidationsByValidator(
  db: D1Database,
  validator: string,
  { limit, offset }: { limit: number; offset: number }
): Promise<{ rows: ValidationRequestRow[]; total: number }> {
  const [countResult, rowsResult] = await Promise.all([
    db
      .prepare(
        "SELECT COUNT(*) AS total FROM validation_requests WHERE validator = ?"
      )
      .bind(validator)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT * FROM validation_requests WHERE validator = ?
         ORDER BY created_at_block DESC
         LIMIT ? OFFSET ?`
      )
      .bind(validator, limit, offset)
      .all<ValidationRequestRow>(),
  ]);

  return {
    rows: rowsResult.results ?? [],
    total: countResult?.total ?? 0,
  };
}

export async function queryValidationByHash(
  db: D1Database,
  requestHash: string
): Promise<ValidationRequestRow | null> {
  return db
    .prepare("SELECT * FROM validation_requests WHERE request_hash = ?")
    .bind(requestHash)
    .first<ValidationRequestRow>();
}

// ============================================================
// Global stats
// ============================================================

export interface GlobalStats {
  agents: number;
  feedback: number;
  validations: number;
}

export async function queryStats(db: D1Database): Promise<GlobalStats> {
  const [agents, feedback, validations] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS total FROM agents")
      .first<{ total: number }>(),
    db
      .prepare("SELECT COUNT(*) AS total FROM feedback")
      .first<{ total: number }>(),
    db
      .prepare("SELECT COUNT(*) AS total FROM validation_requests")
      .first<{ total: number }>(),
  ]);

  return {
    agents: agents?.total ?? 0,
    feedback: feedback?.total ?? 0,
    validations: validations?.total ?? 0,
  };
}

// ============================================================
// Sync state
// ============================================================

export async function querySyncState(db: D1Database): Promise<SyncStateRow[]> {
  const result = await db
    .prepare("SELECT * FROM sync_state ORDER BY contract_id ASC")
    .all<SyncStateRow>();
  return result.results ?? [];
}

// ============================================================
// Blocks seen
// ============================================================

/**
 * Insert or replace a blocks_seen record for the given block.
 * Uses INSERT OR REPLACE so re-processing the same block height is safe.
 * is_canonical resets to 1 on upsert; call markBlockNonCanonical() separately
 * when a fork is detected.
 */
export async function upsertBlockSeen(
  db: D1Database,
  blockHeight: number,
  blockHash: string
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO blocks_seen (block_height, block_hash, is_canonical, indexed_at)
       VALUES (?, ?, 1, datetime('now'))`
    )
    .bind(blockHeight, blockHash)
    .run();
}

/**
 * Mark a previously-seen block as non-canonical (forked/orphaned).
 * No-op if the block has not been seen.
 */
export async function markBlockNonCanonical(
  db: D1Database,
  blockHeight: number
): Promise<void> {
  await db
    .prepare(
      "UPDATE blocks_seen SET is_canonical = 0 WHERE block_height = ?"
    )
    .bind(blockHeight)
    .run();
}

/**
 * Query the most recently indexed blocks, newest first.
 */
export async function queryRecentBlocks(
  db: D1Database,
  { limit, offset }: { limit: number; offset: number }
): Promise<{ rows: BlockSeenRow[]; total: number }> {
  const [countResult, rowsResult] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS total FROM blocks_seen")
      .first<{ total: number }>(),
    db
      .prepare(
        "SELECT * FROM blocks_seen ORDER BY block_height DESC LIMIT ? OFFSET ?"
      )
      .bind(limit, offset)
      .all<BlockSeenRow>(),
  ]);

  return {
    rows: rowsResult.results ?? [],
    total: countResult?.total ?? 0,
  };
}

// ============================================================
// Lenses
// ============================================================

export async function queryLenses(db: D1Database): Promise<LensRow[]> {
  const result = await db
    .prepare("SELECT * FROM lenses ORDER BY name ASC")
    .all<LensRow>();
  return result.results ?? [];
}

export async function queryLensByName(
  db: D1Database,
  name: string
): Promise<LensRow | null> {
  return db
    .prepare("SELECT * FROM lenses WHERE name = ?")
    .bind(name)
    .first<LensRow>();
}

export async function createLens(
  db: D1Database,
  name: string,
  description: string | null,
  config: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO lenses (name, description, config) VALUES (?, ?, ?)"
    )
    .bind(name, description, config)
    .run();
}

export async function updateLens(
  db: D1Database,
  name: string,
  config: string
): Promise<void> {
  await db
    .prepare("UPDATE lenses SET config = ? WHERE name = ?")
    .bind(config, name)
    .run();
}
