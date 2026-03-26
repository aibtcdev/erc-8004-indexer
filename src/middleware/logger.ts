import type { Context, Next } from "hono";
import type { Env, Logger, LogsRPC, AppVariables } from "../types";

const APP_ID = "erc8004-indexer";

/**
 * Type guard to check if LOGS binding has required RPC methods.
 * Exported for reuse by the scheduled handler.
 */
export function isLogsRPC(logs: unknown): logs is LogsRPC {
  return (
    typeof logs === "object" &&
    logs !== null &&
    typeof (logs as LogsRPC).info === "function" &&
    typeof (logs as LogsRPC).warn === "function" &&
    typeof (logs as LogsRPC).error === "function" &&
    typeof (logs as LogsRPC).debug === "function"
  );
}

/**
 * Create a logger backed by either worker-logs RPC or console fallback.
 * Exported for reuse by the scheduled handler (which has no Hono context).
 */
export function createLogger(
  logsBinding: unknown,
  ctx: Pick<ExecutionContext, "waitUntil"> | null,
  baseContext: Record<string, unknown>
): Logger {
  if (isLogsRPC(logsBinding) && ctx) {
    const logs = logsBinding;
    return {
      info: (message, context) => {
        ctx.waitUntil(logs.info(APP_ID, message, { ...baseContext, ...context }));
      },
      warn: (message, context) => {
        ctx.waitUntil(logs.warn(APP_ID, message, { ...baseContext, ...context }));
      },
      error: (message, context) => {
        ctx.waitUntil(logs.error(APP_ID, message, { ...baseContext, ...context }));
      },
      debug: (message, context) => {
        ctx.waitUntil(logs.debug(APP_ID, message, { ...baseContext, ...context }));
      },
    };
  }

  return {
    info: (message, context) => {
      console.log(`[INFO] ${message}`, { ...baseContext, ...context });
    },
    warn: (message, context) => {
      console.warn(`[WARN] ${message}`, { ...baseContext, ...context });
    },
    error: (message, context) => {
      console.error(`[ERROR] ${message}`, { ...baseContext, ...context });
    },
    debug: (message, context) => {
      console.debug(`[DEBUG] ${message}`, { ...baseContext, ...context });
    },
  };
}

/**
 * Logger middleware — creates request-scoped logger and stores in Hono context.
 * Uses worker-logs RPC if LOGS binding is available and valid, else falls back to console.
 */
export async function loggerMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
) {
  const requestId = crypto.randomUUID();
  const baseContext = {
    request_id: requestId,
    path: c.req.path,
    method: c.req.method,
  };

  const logger = createLogger(c.env.LOGS, c.executionCtx, baseContext);

  c.set("requestId", requestId);
  c.set("logger", logger);

  return next();
}
