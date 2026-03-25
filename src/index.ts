import { Hono } from "hono";
import { cors } from "hono/cors";
import { VERSION } from "./version";
import type { Env, AppVariables } from "./types";
import { loggerMiddleware } from "./middleware/logger";
import { requestLoggerMiddleware } from "./middleware/request-logger";
import { webhookRoute } from "./webhook";
import { agentsRoute } from "./routes/agents";
import { feedbackRoute } from "./routes/feedback";
import { validationsRoute } from "./routes/validations";
import { statusRoute } from "./routes/status";
import { lensesRoute } from "./routes/lenses";

// Export IndexerRPC WorkerEntrypoint so other workers can bind to it
export { IndexerRPC } from "./rpc";

// Create Hono app with type safety
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Apply CORS globally
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Apply logger middleware globally (creates request-scoped logger + requestId)
app.use("*", loggerMiddleware);

// Apply request logger globally (logs method, path, status, duration_ms per request)
// Must run after loggerMiddleware so c.var.logger is available
app.use("*", requestLoggerMiddleware);

// Root endpoint — service info
app.get("/", (c) => {
  return c.json({
    service: "erc-8004-indexer",
    version: VERSION,
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Chainhooks 2.0 webhook receiver
app.post("/webhook", webhookRoute);

// REST API v1 — agents, feedback, validations, status, lenses
app.route("/api/v1", agentsRoute);
app.route("/api/v1", feedbackRoute);
app.route("/api/v1", validationsRoute);
app.route("/api/v1", statusRoute);
app.route("/api/v1", lensesRoute);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: "Not Found",
      path: c.req.path,
    },
    404
  );
});

// Error handler
app.onError((err, c) => {
  const logger = c.var.logger;
  if (logger) {
    logger.error("Unhandled error", {
      error: err.message,
      stack: err.stack,
    });
  } else {
    console.error("[ERROR] Unhandled error", err);
  }
  return c.json(
    {
      error: "Internal Server Error",
      message: err.message,
    },
    500
  );
});

export default { fetch: app.fetch };
