import { META_KEYS } from "../lib/constants";
import type { AgentIdentity, AgentRow, IndexRunSummary } from "../lib/types";

/** Upsert a batch of agents into D1 */
export async function upsertAgents(
  db: D1Database,
  agents: AgentIdentity[]
): Promise<{ new_count: number; updated_count: number }> {
  let new_count = 0;
  let updated_count = 0;
  const now = new Date().toISOString();

  for (const agent of agents) {
    const existing = await db
      .prepare("SELECT agent_id, owner, uri, wallet FROM agents WHERE agent_id = ?")
      .bind(agent.agent_id)
      .first<AgentRow>();

    if (!existing) {
      await db
        .prepare(
          "INSERT INTO agents (agent_id, owner, uri, wallet, network, indexed_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
        )
        .bind(agent.agent_id, agent.owner, agent.uri, agent.wallet, agent.network, now, now)
        .run();
      new_count++;
    } else {
      const changed =
        existing.owner !== agent.owner ||
        existing.uri !== agent.uri ||
        existing.wallet !== agent.wallet;

      if (changed) {
        await db
          .prepare(
            "UPDATE agents SET owner = ?1, uri = ?2, wallet = ?3, updated_at = ?4 WHERE agent_id = ?5"
          )
          .bind(agent.owner, agent.uri, agent.wallet, now, agent.agent_id)
          .run();
        updated_count++;
      }
    }
  }

  return { new_count, updated_count };
}

/** Get all indexed agents */
export async function getAllAgents(db: D1Database): Promise<AgentRow[]> {
  const result = await db
    .prepare("SELECT * FROM agents ORDER BY agent_id ASC")
    .all<AgentRow>();
  return result.results;
}

/** Get a single agent by ID */
export async function getAgentById(
  db: D1Database,
  agentId: number
): Promise<AgentRow | null> {
  return db
    .prepare("SELECT * FROM agents WHERE agent_id = ?")
    .bind(agentId)
    .first<AgentRow>();
}

/** Get agents by owner address */
export async function getAgentsByOwner(
  db: D1Database,
  owner: string
): Promise<AgentRow[]> {
  const result = await db
    .prepare("SELECT * FROM agents WHERE owner = ? ORDER BY agent_id ASC")
    .bind(owner)
    .all<AgentRow>();
  return result.results;
}

/** Get total agent count */
export async function getAgentCount(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM agents")
    .first<{ count: number }>();
  return result?.count ?? 0;
}

/** Get or set index metadata */
export async function getMeta(
  db: D1Database,
  key: string
): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM index_meta WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMeta(
  db: D1Database,
  key: string,
  value: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO index_meta (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')"
    )
    .bind(key, value)
    .run();
}

/** Save index run summary */
export async function saveIndexRunSummary(
  db: D1Database,
  summary: IndexRunSummary
): Promise<void> {
  await setMeta(db, META_KEYS.LAST_AGENT_ID, String(summary.last_agent_id));
  await setMeta(db, META_KEYS.LAST_INDEX_RUN, summary.timestamp);
  await setMeta(db, META_KEYS.LAST_INDEX_SUMMARY, JSON.stringify(summary));
}

/** Get last index run summary */
export async function getLastIndexRun(
  db: D1Database
): Promise<IndexRunSummary | null> {
  const raw = await getMeta(db, META_KEYS.LAST_INDEX_SUMMARY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IndexRunSummary;
  } catch {
    return null;
  }
}
