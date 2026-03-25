/**
 * Shared helpers for route handlers.
 */
import type { Context } from "hono";
import type { Env, AppVariables } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

/**
 * Parse a numeric agent ID from a route parameter.
 * Returns the parsed number, or sends a 400 JSON error and returns null.
 */
export function parseAgentId(c: AppContext): number | null {
  const agentId = parseInt(c.req.param("id") ?? "", 10);
  if (isNaN(agentId)) {
    c.status(400);
    return null;
  }
  return agentId;
}

/**
 * Parse optional feedback filter query parameters.
 * Returns an object with `client`, `tag1`, and `tag2` (undefined if not set).
 */
export function parseFeedbackFilters(c: AppContext): {
  client?: string;
  tag1?: string;
  tag2?: string;
} {
  const query = c.req.query();
  return {
    client: query.client ?? undefined,
    tag1: query.tag1 ?? undefined,
    tag2: query.tag2 ?? undefined,
  };
}

/**
 * Parse `block` query parameter for lens endpoints.
 * Returns the parsed block height or a large sentinel value.
 */
export function parseBlockParam(c: AppContext): number {
  const blockParam = c.req.query("block");
  if (!blockParam) return 999999999;
  const parsed = parseInt(blockParam, 10);
  return isNaN(parsed) ? 999999999 : parsed;
}
