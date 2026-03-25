import { Hono } from "hono";
import { cors } from "hono/cors";
import { VERSION } from "./version";
import type { Env, AppVariables } from "./types";
import { loggerMiddleware } from "./middleware/logger";
import { webhookRoute } from "./webhook";

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
