/**
 * Lens API routes under /api/v1.
 *
 * GET  /api/v1/lenses                             — list all lenses
 * GET  /api/v1/lenses/:lens                       — get single lens config
 * GET  /api/v1/lenses/:lens/agents/:id/summary    — run pipeline, return full result
 * GET  /api/v1/lenses/:lens/agents/:id/feedback   — list feedback passing lens filters
 * GET  /api/v1/lenses/:lens/agents/:id/score      — return just the score
 * POST /api/v1/lenses                             — create lens (admin)
 * PUT  /api/v1/lenses/:lens                       — update lens config (admin)
 */
import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import {
  queryLenses,
  queryLensByName,
  createLens,
  updateLens,
} from "../utils/query";
import { runLensPipeline } from "../lenses/pipeline";
import { mergeLensConfig } from "../lenses/defaults";
import type { LensConfig } from "../lenses/types";

export const lensesRoute = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse and validate admin authorization.
 * Checks Bearer token against ADMIN_TOKEN env var (if set) or KV key "admin_token".
 * Returns true if the request carries a matching token.
 */
async function isAdminAuthorized(
  env: Env,
  authHeader: string | undefined
): Promise<boolean> {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1];
  // Check env var first (production/staging)
  if (env.ADMIN_TOKEN) {
    return token === env.ADMIN_TOKEN;
  }
  // Fall back to KV (dev / test)
  const kvToken = await env.INDEXER_KV.get("admin_token");
  if (kvToken) {
    return token === kvToken;
  }
  return false;
}

/**
 * Parse the lens config JSON from a LensRow.config string.
 * Returns a merged LensConfig (filling defaults for any missing fields).
 */
function parseLensConfig(configJson: string): LensConfig {
  try {
    const parsed = JSON.parse(configJson) as Partial<LensConfig>;
    return mergeLensConfig(parsed);
  } catch {
    return mergeLensConfig({});
  }
}

// ── Read endpoints ────────────────────────────────────────────────────────────

// GET /lenses — list all lenses
lensesRoute.get("/lenses", async (c) => {
  const rows = await queryLenses(c.env.DB);
  const lenses = rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    config: parseLensConfig(row.config),
    created_at: row.created_at,
  }));
  return c.json(lenses);
});

// GET /lenses/:lens — get single lens
lensesRoute.get("/lenses/:lens", async (c) => {
  const name = c.req.param("lens");
  const row = await queryLensByName(c.env.DB, name);
  if (!row) {
    return c.json({ error: "Not Found" }, 404);
  }
  return c.json({
    id: row.id,
    name: row.name,
    description: row.description,
    config: parseLensConfig(row.config),
    created_at: row.created_at,
  });
});

// GET /lenses/:lens/agents/:id/summary — full pipeline result
lensesRoute.get("/lenses/:lens/agents/:id/summary", async (c) => {
  const lensName = c.req.param("lens");
  const agentId = parseInt(c.req.param("id"), 10);
  if (isNaN(agentId)) {
    return c.json({ error: "Invalid agent ID" }, 400);
  }

  const row = await queryLensByName(c.env.DB, lensName);
  if (!row) {
    return c.json({ error: "Lens not found" }, 404);
  }

  const config = parseLensConfig(row.config);

  // Use query param `block` as current block; default to a large sentinel
  const blockParam = c.req.query("block");
  const currentBlock = blockParam ? parseInt(blockParam, 10) : 999999999;

  const result = await runLensPipeline(
    c.env.DB,
    agentId,
    lensName,
    config,
    isNaN(currentBlock) ? 999999999 : currentBlock
  );

  return c.json(result);
});

// GET /lenses/:lens/agents/:id/feedback — list feedback that passes lens filters
// Returns transparency metadata alongside the list.
lensesRoute.get("/lenses/:lens/agents/:id/feedback", async (c) => {
  const lensName = c.req.param("lens");
  const agentId = parseInt(c.req.param("id"), 10);
  if (isNaN(agentId)) {
    return c.json({ error: "Invalid agent ID" }, 400);
  }

  const row = await queryLensByName(c.env.DB, lensName);
  if (!row) {
    return c.json({ error: "Lens not found" }, 404);
  }

  const config = parseLensConfig(row.config);
  const blockParam = c.req.query("block");
  const currentBlock = blockParam ? parseInt(blockParam, 10) : 999999999;

  // Run pipeline to get filtered entries + metadata
  const result = await runLensPipeline(
    c.env.DB,
    agentId,
    lensName,
    config,
    isNaN(currentBlock) ? 999999999 : currentBlock
  );

  // Re-fetch the included feedback IDs by running pipeline again with full data
  // For this endpoint we return the metadata alongside the score
  return c.json({
    agent_id: agentId,
    lens_name: lensName,
    included_count: result.included_count,
    excluded_count: result.excluded_count,
    exclusions: result.exclusions,
    flags: result.flags,
  });
});

// GET /lenses/:lens/agents/:id/score — just the score
lensesRoute.get("/lenses/:lens/agents/:id/score", async (c) => {
  const lensName = c.req.param("lens");
  const agentId = parseInt(c.req.param("id"), 10);
  if (isNaN(agentId)) {
    return c.json({ error: "Invalid agent ID" }, 400);
  }

  const row = await queryLensByName(c.env.DB, lensName);
  if (!row) {
    return c.json({ error: "Lens not found" }, 404);
  }

  const config = parseLensConfig(row.config);
  const blockParam = c.req.query("block");
  const currentBlock = blockParam ? parseInt(blockParam, 10) : 999999999;

  const result = await runLensPipeline(
    c.env.DB,
    agentId,
    lensName,
    config,
    isNaN(currentBlock) ? 999999999 : currentBlock
  );

  return c.json({
    agent_id: agentId,
    lens_name: lensName,
    score: result.score,
  });
});

// ── Admin endpoints ───────────────────────────────────────────────────────────

// POST /lenses — create a new lens (admin)
lensesRoute.post("/lenses", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!(await isAdminAuthorized(c.env, authHeader))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: { name?: string; description?: string; config?: Partial<LensConfig> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "Missing required field: name" }, 400);
  }

  const config = mergeLensConfig(body.config ?? {});
  const configJson = JSON.stringify(config);
  const description = body.description ?? null;

  try {
    await createLens(c.env.DB, body.name, description, configJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      return c.json({ error: "Lens already exists" }, 409);
    }
    throw err;
  }

  const created = await queryLensByName(c.env.DB, body.name);
  if (!created) {
    return c.json({ error: "Internal Server Error" }, 500);
  }

  return c.json(
    {
      id: created.id,
      name: created.name,
      description: created.description,
      config,
      created_at: created.created_at,
    },
    201
  );
});

// PUT /lenses/:lens — update lens config (admin)
lensesRoute.put("/lenses/:lens", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!(await isAdminAuthorized(c.env, authHeader))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const name = c.req.param("lens");
  const existing = await queryLensByName(c.env.DB, name);
  if (!existing) {
    return c.json({ error: "Lens not found" }, 404);
  }

  let body: { config?: Partial<LensConfig> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const config = mergeLensConfig(body.config ?? {});
  const configJson = JSON.stringify(config);

  await updateLens(c.env.DB, name, configJson);

  return c.json({
    id: existing.id,
    name: existing.name,
    description: existing.description,
    config,
    created_at: existing.created_at,
  });
});
