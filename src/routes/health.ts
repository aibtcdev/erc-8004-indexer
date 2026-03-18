import { Hono } from "hono";
import type { Env } from "../lib/types";
import { getAgentCount, getLastIndexRun } from "../services/db";

const healthRouter = new Hono<{ Bindings: Env }>();

/** GET / — Service info */
healthRouter.get("/", (c) => {
  return c.json({
    service: "erc-8004-indexer",
    description: "ERC-8004 Agent Identity Registry Indexer",
    version: "1.0.0",
    endpoints: {
      "GET /": "Service info",
      "GET /health": "Health check with index status",
      "GET /agents": "List all agents (optional ?owner=SP... filter)",
      "GET /agents/count": "Agent count",
      "GET /agents/:id": "Single agent by ID",
      "GET /stats": "Index statistics",
    },
  });
});

/** GET /health — Health check */
healthRouter.get("/health", async (c) => {
  const [count, lastRun] = await Promise.all([
    getAgentCount(c.env.DB),
    getLastIndexRun(c.env.DB),
  ]);

  const healthy = count > 0;
  const status = healthy ? "ok" : "degraded";

  return c.json(
    {
      status,
      agent_count: count,
      last_index_run: lastRun?.timestamp ?? null,
      last_index_duration_ms: lastRun?.duration_ms ?? null,
      network: c.env.STACKS_NETWORK,
      environment: c.env.ENVIRONMENT,
    },
    healthy ? 200 : 503
  );
});

/** GET /stats — Index statistics */
healthRouter.get("/stats", async (c) => {
  const [count, lastRun] = await Promise.all([
    getAgentCount(c.env.DB),
    getLastIndexRun(c.env.DB),
  ]);

  return c.json({
    total_agents: count,
    last_agent_id: lastRun?.last_agent_id ?? 0,
    last_index: lastRun
      ? {
          timestamp: lastRun.timestamp,
          duration_ms: lastRun.duration_ms,
          agents_indexed: lastRun.agents_indexed,
          agents_new: lastRun.agents_new,
          agents_updated: lastRun.agents_updated,
        }
      : null,
    network: c.env.STACKS_NETWORK,
  });
});

export { healthRouter };
