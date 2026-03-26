/**
 * Status and stats routes under /api/v1.
 *
 * GET /api/v1/status — indexer health and sync state
 * GET /api/v1/stats  — global entity counts
 */
import { Hono } from "hono";
import type { Env, AppVariables, SyncStateRow } from "../types";
import { VERSION } from "../version";
import { queryStats, querySyncState, queryRecentBlocks } from "../utils/query";
import { readSourceHealth } from "../utils/source-health";

export const statusRoute = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// GET /status — indexer health with sync state per contract
statusRoute.get("/status", async (c) => {
  const [syncState, sourceHealth, recentBlocksResult] = await Promise.all([
    querySyncState(c.env.DB),
    readSourceHealth(c.env.INDEXER_KV),
    queryRecentBlocks(c.env.DB, { limit: 5, offset: 0 }),
  ]);

  // Compute gap between last known chain tip and last indexed block
  const lastIndexedBlock =
    syncState.length > 0
      ? Math.max(...syncState.map((r: SyncStateRow) => r.last_indexed_block))
      : 0;
  const currentBlock = sourceHealth?.last_block_height ?? 0;
  const gap =
    currentBlock > 0 || lastIndexedBlock > 0
      ? {
          current_block: currentBlock,
          last_indexed_block: lastIndexedBlock,
          gap_size: currentBlock - lastIndexedBlock,
        }
      : null;

  return c.json({
    status: "ok",
    version: VERSION,
    timestamp: new Date().toISOString(),
    sync_state: syncState,
    source_health: sourceHealth,
    recent_blocks: recentBlocksResult.rows,
    gap,
  });
});

// GET /stats — global counts of agents, feedback, validations
statusRoute.get("/stats", async (c) => {
  const stats = await queryStats(c.env.DB);
  return c.json(stats);
});
