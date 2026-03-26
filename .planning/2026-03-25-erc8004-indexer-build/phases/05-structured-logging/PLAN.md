<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Enrich all webhook processing, event handlers, and API endpoints with structured logs that use a consistent appId "erc8004-indexer", add request/response timing middleware, enhance webhook.ts with processing metrics, add error-level logging for DB failures, warn-level for anomalies, and create worker-logs app registration instructions.</goal>
  <context>
    The Phase 1 logger middleware already exists at src/middleware/logger.ts with RPC + console fallback.
    Current APP_ID is "erc-8004-indexer" (hyphen) but the spec requires "erc8004-indexer" (no hyphen).
    All handlers already have INFO logs with agentId, blockHeight, txHash — but DB writes have no error handling.
    webhook.ts already logs payload receipt and handler errors but lacks:
      - Processed event count summary
      - Processing duration timing
      - Rollback count in summary log
      - Error-level for DB write failures in individual handlers
    The API index.ts has no route-level request logging (just the global logger middleware).
    No request-logger middleware exists yet.
    No worker-logs app registration exists for "erc8004-indexer".
  </context>

  <task id="1">
    <name>Fix APP_ID and add request-logger middleware</name>
    <files>
      src/middleware/logger.ts,
      src/middleware/request-logger.ts (new)
    </files>
    <action>
      1. In src/middleware/logger.ts: change APP_ID from "erc-8004-indexer" to "erc8004-indexer" (remove hyphen between erc and 8004).

      2. Create src/middleware/request-logger.ts:
         - Export async function requestLoggerMiddleware(c, next)
         - Record start time before calling next()
         - After next(), compute duration_ms = Date.now() - start
         - Call logger.info("request", { method, path, status, duration_ms })
         - The logger is c.var.logger — it may not be set yet if loggerMiddleware hasn't run, so check before using
         - Use the same Context generic: Context&lt;{ Bindings: Env; Variables: AppVariables }&gt;
    </action>
    <verify>
      npm run check  (TypeScript must compile with no errors)
    </verify>
    <done>APP_ID is "erc8004-indexer", request-logger.ts exists and exports requestLoggerMiddleware</done>
  </task>

  <task id="2">
    <name>Enhance webhook.ts with processing metrics and add DB error handling to handlers</name>
    <files>
      src/webhook.ts,
      src/handlers/identity.ts,
      src/handlers/reputation.ts,
      src/handlers/validation.ts,
      src/handlers/rollback.ts
    </files>
    <action>
      1. In src/webhook.ts:
         - Add a start timestamp at the top of webhookRoute (before auth check): const startMs = Date.now()
         - Track eventsReceived counter: increment for each contract_log op on a watched contract
         - Track eventsProcessed counter: increment when routeEvent returns true
         - At the end (before return), add a summary INFO log:
           logger.info("webhookRoute: completed", {
             blockCount: payload.event?.apply?.length ?? 0,
             rollbackCount: payload.event?.rollback?.length ?? 0,
             eventsReceived,
             eventsProcessed,
             duration_ms: Date.now() - startMs,
           })
         - Add ERROR log for auth failures with context: { hasToken, path: "auth" }

      2. In src/handlers/identity.ts — wrap each DB .run() call in try/catch:
         - Catch errors and call logger.error("handleXxx: db write failed", { agentId, error: String(err), blockHeight, txHash })
         - Re-throw the error after logging so the webhook can track failures

      3. In src/handlers/reputation.ts — same pattern:
         - Wrap DB writes in try/catch with logger.error calls
         - Add warn-level anomaly detection for FeedbackRevoked: if this is a bulk pattern hint,
           log a warning (simple: always log warn after FeedbackRevoked with { agentId, client, index })
           Actually: add a warn log if the agent has any existing revocations in this block — but since
           we don't query mid-handler, use a simpler heuristic: just ensure handleFeedbackRevoked always
           logs a warn with context about potential bulk revocation for downstream monitoring.
           Add: logger.warn("handleFeedbackRevoked: feedback revocation recorded", { agentId, client, index, blockHeight, txHash })
           alongside the existing info log.

      4. In src/handlers/validation.ts — wrap DB writes in try/catch with logger.error calls

      5. In src/handlers/rollback.ts — wrap db.batch() in try/catch with logger.error call:
         logger.error("handleRollback: batch failed", { blockHeight, txHash, error: String(err) })
         Re-throw after logging.
    </action>
    <verify>
      npm run check  (TypeScript must compile)
      npm test       (All 20+ existing tests must still pass)
    </verify>
    <done>
      webhook.ts emits a summary INFO log with eventsReceived, eventsProcessed, rollbackCount, duration_ms.
      All handlers have try/catch around DB writes with ERROR logs.
      FeedbackRevoked emits a WARN log.
    </done>
  </task>

  <task id="3">
    <name>Wire request-logger into app and create worker-logs registration instructions</name>
    <files>
      src/index.ts,
      scripts/register-worker-logs-app.ts (new)
    </files>
    <action>
      1. In src/index.ts:
         - Import requestLoggerMiddleware from "./middleware/request-logger"
         - Add app.use("*", requestLoggerMiddleware) AFTER the loggerMiddleware line
           (so the logger is available in context when requestLoggerMiddleware runs)

      2. Create scripts/register-worker-logs-app.ts:
         - A tsx script that registers "erc8004-indexer" as an app in the worker-logs service
         - Uses the worker-logs HTTP API (POST /apps) with ADMIN_API_KEY from env
         - Reads WORKER_LOGS_URL and ADMIN_API_KEY from process.env (loaded from .env)
         - Prints instructions and result to console
         - Add "register-logs-app" script to package.json:
           "register-logs-app": "tsx --tsconfig tsconfig.scripts.json scripts/register-worker-logs-app.ts"

      3. Also add to package.json scripts:
         No new package.json changes beyond the register-logs-app entry.
    </action>
    <verify>
      npm run check  (TypeScript must compile)
      npm test       (All tests must pass)
    </verify>
    <done>
      requestLoggerMiddleware is registered in the Hono app after loggerMiddleware.
      scripts/register-worker-logs-app.ts exists and can be run with npm run register-logs-app.
    </done>
  </task>
</plan>
