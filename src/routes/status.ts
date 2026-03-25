/**
 * Status and stats routes under /api/v1.
 *
 * GET /api/v1/status — indexer health and sync state
 * GET /api/v1/stats  — global entity counts
 */
import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { VERSION } from "../version";
import { queryStats, querySyncState } from "../utils/query";

export const statusRoute = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// GET /status — indexer health with sync state per contract
statusRoute.get("/status", async (c) => {
  const syncState = await querySyncState(c.env.DB);
  return c.json({
    status: "ok",
    version: VERSION,
    timestamp: new Date().toISOString(),
    sync_state: syncState,
  });
});

// GET /stats — global counts of agents, feedback, validations
statusRoute.get("/stats", async (c) => {
  const stats = await queryStats(c.env.DB);
  return c.json(stats);
});
