import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, IndexRunSummary } from "./lib/types";
import { agentsRouter } from "./routes/agents";
import { healthRouter } from "./routes/health";
import { createLogger, createScheduledLogger } from "./middleware/logger";
import { fetchAllAgents } from "./services/stacks";
import { upsertAgents, saveIndexRunSummary, getMeta } from "./services/db";
import { META_KEYS } from "./lib/constants";

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use("*", cors());

// Request logging
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const logger = createLogger(c);
  logger.info("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: duration,
  });
});

// Mount routes
app.route("/", healthRouter);
app.route("/", agentsRouter);

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler
app.onError((err, c) => {
  const logger = createLogger(c);
  logger.error("unhandled error", { error: err.message, stack: err.stack });
  return c.json({ error: "Internal server error" }, 500);
});

/** Run the indexer: fetch all agents from chain and upsert into D1 */
async function runIndexer(env: Env, logger: { info: Function; warn: Function; error: Function }): Promise<IndexRunSummary> {
  const start = Date.now();
  const network = env.STACKS_NETWORK;
  const apiUrl = env.STACKS_API_URL;

  // Get last known agent ID for fallback
  const lastKnownStr = await getMeta(env.DB, META_KEYS.LAST_AGENT_ID);
  const lastKnown = lastKnownStr ? parseInt(lastKnownStr, 10) : undefined;

  logger.info("index run starting", { network, api_url: apiUrl, last_known_id: lastKnown });

  // Fetch all agents from chain
  const { agents, lastAgentId } = await fetchAllAgents(apiUrl, network, lastKnown);

  logger.info("fetched agents from chain", {
    count: agents.length,
    last_agent_id: lastAgentId,
  });

  // Upsert into D1
  const { new_count, updated_count } = await upsertAgents(env.DB, agents);

  const duration = Date.now() - start;
  const summary: IndexRunSummary = {
    last_agent_id: lastAgentId,
    agents_indexed: agents.length,
    agents_updated: updated_count,
    agents_new: new_count,
    duration_ms: duration,
    network,
    timestamp: new Date().toISOString(),
  };

  // Save run metadata
  await saveIndexRunSummary(env.DB, summary);

  logger.info("index run complete", summary as unknown as Record<string, unknown>);

  return summary;
}

export default {
  fetch: app.fetch,

  /** Cron trigger handler — runs the indexer on schedule */
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const logger = createScheduledLogger(env, ctx);
    try {
      await runIndexer(env, logger);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("scheduled index run failed", {
        error: error.message,
        stack: error.stack,
      });
    }
  },
};
