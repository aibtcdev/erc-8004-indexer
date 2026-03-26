/**
 * Request logger middleware — logs method, path, status, and duration for every request.
 *
 * Must be registered AFTER loggerMiddleware so that c.var.logger is available.
 */
import type { Context, Next } from "hono";
import type { Env, AppVariables } from "../types";

export async function requestLoggerMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
): Promise<void> {
  const start = Date.now();

  await next();

  const logger = c.var.logger;
  if (!logger) return;

  const duration_ms = Date.now() - start;
  logger.info("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms,
  });
}
