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
import { mergeLensConfig, parseLensConfig } from "../lenses/defaults";
import type { LensConfig } from "../lenses/types";
import { parseAgentId, parseBlockParam } from "./helpers";

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

type LensPipelineSuccess = { ok: true; result: Awaited<ReturnType<typeof runLensPipeline>> };
type LensPipelineFailure = { ok: false; error: string; status: 400 | 404 };

/**
 * Shared helper: validate agent ID, look up lens, parse config, run pipeline.
 */
async function resolveLensPipeline(
  c: import("hono").Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<LensPipelineSuccess | LensPipelineFailure> {
  const agentId = parseAgentId(c);
  if (agentId === null) return { ok: false, error: "Invalid agent ID", status: 400 };

  const lensName = c.req.param("lens") ?? "";
  const row = await queryLensByName(c.env.DB, lensName);
  if (!row) return { ok: false, error: "Lens not found", status: 404 };

  const config = parseLensConfig(row.config);
  const currentBlock = parseBlockParam(c);
  const result = await runLensPipeline(c.env.DB, agentId, lensName, config, currentBlock);
  return { ok: true, result };
}

// GET /lenses/:lens/agents/:id/summary — full pipeline result
lensesRoute.get("/lenses/:lens/agents/:id/summary", async (c) => {
  const resolved = await resolveLensPipeline(c);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  return c.json(resolved.result);
});

// GET /lenses/:lens/agents/:id/feedback — transparency metadata for lens filtering
lensesRoute.get("/lenses/:lens/agents/:id/feedback", async (c) => {
  const resolved = await resolveLensPipeline(c);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  return c.json({
    agent_id: resolved.result.agent_id,
    lens_name: resolved.result.lens_name,
    included_count: resolved.result.included_count,
    excluded_count: resolved.result.excluded_count,
    exclusions: resolved.result.exclusions,
    flags: resolved.result.flags,
  });
});

// GET /lenses/:lens/agents/:id/score — just the score
lensesRoute.get("/lenses/:lens/agents/:id/score", async (c) => {
  const resolved = await resolveLensPipeline(c);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  return c.json({
    agent_id: resolved.result.agent_id,
    lens_name: resolved.result.lens_name,
    score: resolved.result.score,
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
