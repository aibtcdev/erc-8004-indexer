import type { Context } from "hono";
import { APP_ID } from "../lib/constants";
import type { Env } from "../lib/types";

export interface Logger {
  info: (msg: string, context?: Record<string, unknown>) => void;
  warn: (msg: string, context?: Record<string, unknown>) => void;
  error: (msg: string, context?: Record<string, unknown>) => void;
}

/** Create a logger that sends to worker-logs RPC if available, else console */
export function createLogger(
  c: Context<{ Bindings: Env }>,
  baseContext?: Record<string, unknown>
): Logger {
  const logs = c.env.LOGS;
  const ctx = c.executionCtx;
  const base = baseContext ?? {};

  if (logs) {
    return {
      info: (msg, context) =>
        ctx.waitUntil(logs.info(APP_ID, msg, { ...base, ...context })),
      warn: (msg, context) =>
        ctx.waitUntil(logs.warn(APP_ID, msg, { ...base, ...context })),
      error: (msg, context) =>
        ctx.waitUntil(logs.error(APP_ID, msg, { ...base, ...context })),
    };
  }

  return {
    info: (msg, context) => console.log(`[INFO] ${msg}`, { ...base, ...context }),
    warn: (msg, context) => console.warn(`[WARN] ${msg}`, { ...base, ...context }),
    error: (msg, context) => console.error(`[ERROR] ${msg}`, { ...base, ...context }),
  };
}

/** Create a logger for scheduled events (no Hono context) */
export function createScheduledLogger(
  env: Env,
  ctx: ExecutionContext
): Logger {
  const logs = env.LOGS;

  if (logs) {
    return {
      info: (msg, context) =>
        ctx.waitUntil(logs.info(APP_ID, msg, { trigger: "scheduled", ...context })),
      warn: (msg, context) =>
        ctx.waitUntil(logs.warn(APP_ID, msg, { trigger: "scheduled", ...context })),
      error: (msg, context) =>
        ctx.waitUntil(logs.error(APP_ID, msg, { trigger: "scheduled", ...context })),
    };
  }

  return {
    info: (msg, context) => console.log(`[INFO] ${msg}`, { trigger: "scheduled", ...context }),
    warn: (msg, context) => console.warn(`[WARN] ${msg}`, { trigger: "scheduled", ...context }),
    error: (msg, context) => console.error(`[ERROR] ${msg}`, { trigger: "scheduled", ...context }),
  };
}
