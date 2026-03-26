/**
 * Integration tests for the reputation lens system.
 *
 * Tests cover:
 * - Listing lenses (includes seeded "aibtc" lens)
 * - Fetching a single lens config
 * - 404 for non-existent lens
 * - Pipeline: score=0 for agent with no feedback
 * - Pipeline: same raw data through different lenses produces different scores
 *   (aibtc requires approved clients; "open" lens accepts all)
 * - Admin CRUD: POST /lenses without token returns 401
 * - Admin CRUD: POST /lenses with token creates a lens
 * - Admin CRUD: PUT /lenses/:lens updates the config
 */
import { describe, it, expect } from "vitest";
import { SELF, env as rawEnv } from "cloudflare:test";
import type { Env } from "../types";
import { setupDb, clearData, seedLenses } from "./helpers";

import applyIdentityFixture from "./fixtures/apply-identity.json";
import applyReputationFixture from "./fixtures/apply-reputation.json";

const env = rawEnv as unknown as Env;

const TEST_SECRET = "test-api-secret";
const ADMIN_TOKEN = "test-admin-token";
const BASE_URL = "http://localhost/api/v1";
const WEBHOOK_URL = "http://localhost/webhook";

async function postWebhook(body: unknown): Promise<Response> {
  return SELF.fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_SECRET}`,
    },
    body: JSON.stringify(body),
  });
}

async function getEndpoint(path: string): Promise<Response> {
  return SELF.fetch(`${BASE_URL}${path}`);
}

async function postEndpoint(
  path: string,
  body: unknown,
  authToken?: string
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return SELF.fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function putEndpoint(
  path: string,
  body: unknown,
  authToken?: string
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return SELF.fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Seed: set up schema with the aibtc lens, configure secrets, and optionally
 * post identity + reputation webhooks to create feedback data.
 */
async function seedBase(): Promise<void> {
  await setupDb(env.DB);
  await clearData(env.DB);
  // Re-seed the aibtc reference lens after clearData() wiped it
  await seedLenses(env.DB);
  await env.INDEXER_KV.put("webhook_secret", TEST_SECRET);
  // Store admin token in KV so the lenses route can look it up during tests
  await env.INDEXER_KV.put("admin_token", ADMIN_TOKEN);
}

async function seedWithFeedback(): Promise<void> {
  await seedBase();
  const r1 = await postWebhook(applyIdentityFixture);
  if (!r1.ok) throw new Error(`Identity fixture failed: ${r1.status}`);
  const r2 = await postWebhook(applyReputationFixture);
  if (!r2.ok) throw new Error(`Reputation fixture failed: ${r2.status}`);
}

// ============================================================
// GET /lenses
// ============================================================

describe("GET /api/v1/lenses", () => {
  it("returns array including the seeded aibtc lens", async () => {
    await seedBase();
    const res = await getEndpoint("/lenses");
    expect(res.status).toBe(200);
    const body = await res.json<
      { name: string; config: Record<string, unknown> }[]
    >();
    expect(Array.isArray(body)).toBe(true);
    const aibtc = body.find((l) => l.name === "aibtc");
    expect(aibtc).toBeDefined();
    expect(aibtc!.config).toBeDefined();
  });

  it("returns lens config with all 5 dimensions", async () => {
    await seedBase();
    const res = await getEndpoint("/lenses");
    expect(res.status).toBe(200);
    const body = await res.json<{ name: string; config: Record<string, unknown> }[]>();
    const aibtc = body.find((l) => l.name === "aibtc");
    expect(aibtc!.config).toHaveProperty("trust");
    expect(aibtc!.config).toHaveProperty("bounds");
    expect(aibtc!.config).toHaveProperty("rate");
    expect(aibtc!.config).toHaveProperty("decay");
    expect(aibtc!.config).toHaveProperty("weight");
  });
});

// ============================================================
// GET /lenses/:lens
// ============================================================

describe("GET /api/v1/lenses/:lens", () => {
  it("returns aibtc lens config object", async () => {
    await seedBase();
    const res = await getEndpoint("/lenses/aibtc");
    expect(res.status).toBe(200);
    const body = await res.json<{
      name: string;
      config: {
        trust: { approved_clients_only: boolean };
        bounds: { min_wad_value: string; max_wad_value: string };
        rate: { max_per_reviewer_per_window: number; window_blocks: number };
        decay: { enabled: boolean; half_life_blocks: number };
        weight: { enabled: boolean };
      };
    }>();
    expect(body.name).toBe("aibtc");
    expect(body.config.trust.approved_clients_only).toBe(true);
    expect(body.config.bounds.min_wad_value).toBe("-100000000000000000000");
    expect(body.config.rate.max_per_reviewer_per_window).toBe(10);
    expect(body.config.rate.window_blocks).toBe(144);
    expect(body.config.decay.enabled).toBe(true);
    expect(body.config.decay.half_life_blocks).toBe(4320);
    expect(body.config.weight.enabled).toBe(false);
  });

  it("returns 404 for non-existent lens", async () => {
    await seedBase();
    const res = await getEndpoint("/lenses/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("Not Found");
  });
});

// ============================================================
// GET /lenses/:lens/agents/:id/score
// ============================================================

describe("GET /api/v1/lenses/:lens/agents/:id/score", () => {
  it("returns score=0 for agent with no feedback", async () => {
    await seedBase();
    // Insert a bare agent with no feedback
    await env.DB.prepare(
      "INSERT INTO agents (agent_id, owner, created_at_block, created_at_tx) VALUES (99, 'SPTEST99', 1, '0xtx_test')"
    ).run();
    const res = await getEndpoint("/lenses/aibtc/agents/99/score");
    expect(res.status).toBe(200);
    const body = await res.json<{
      agent_id: number;
      lens_name: string;
      score: string;
    }>();
    expect(body.agent_id).toBe(99);
    expect(body.lens_name).toBe("aibtc");
    expect(body.score).toBe("0");
  });

  it("returns 404 score for non-existent lens", async () => {
    await seedBase();
    const res = await getEndpoint("/lenses/doesnotexist/agents/1/score");
    expect(res.status).toBe(404);
  });
});

// ============================================================
// GET /lenses/:lens/agents/:id/summary
// ============================================================

describe("GET /api/v1/lenses/:lens/agents/:id/summary", () => {
  it("returns summary with included_count=0 for agent with no feedback", async () => {
    await seedBase();
    await env.DB.prepare(
      "INSERT INTO agents (agent_id, owner, created_at_block, created_at_tx) VALUES (98, 'SPTEST98', 1, '0xtx_test')"
    ).run();
    const res = await getEndpoint("/lenses/aibtc/agents/98/summary");
    expect(res.status).toBe(200);
    const body = await res.json<{
      included_count: number;
      excluded_count: number;
      score: string;
      exclusions: unknown[];
      flags: string[];
    }>();
    expect(body.included_count).toBe(0);
    expect(body.excluded_count).toBe(0);
    expect(body.score).toBe("0");
    expect(Array.isArray(body.exclusions)).toBe(true);
    expect(Array.isArray(body.flags)).toBe(true);
  });

  it("summary includes transparency metadata with exclusion records", async () => {
    // Seed with feedback from a non-approved client so trust filter fires
    await seedBase();
    await env.DB.prepare(
      "INSERT INTO agents (agent_id, owner, created_at_block, created_at_tx) VALUES (97, 'SPTEST97', 1, '0xtx_test')"
    ).run();
    // Insert feedback from a non-approved client
    await env.DB.prepare(
      `INSERT INTO feedback (agent_id, client, feedback_index, value, value_decimals,
        wad_value, tag1, tag2, endpoint, feedback_uri, feedback_hash,
        is_revoked, created_at_block, created_at_tx)
       VALUES (97, 'SP_UNAPPROVED', 0, '5000000000000000000', '18',
        '5000000000000000000', 'quality', '', '', 'uri', 'hash',
        0, 100, '0xtx1')`
    ).run();

    // aibtc requires approved_clients_only — should exclude the feedback
    const res = await getEndpoint("/lenses/aibtc/agents/97/summary?block=200");
    expect(res.status).toBe(200);
    const body = await res.json<{
      included_count: number;
      excluded_count: number;
      exclusions: { reason: string; count: number }[];
    }>();
    expect(body.included_count).toBe(0);
    expect(body.excluded_count).toBe(1);
    const trustExclusion = body.exclusions.find((e) => e.reason === "trust");
    expect(trustExclusion).toBeDefined();
    expect(trustExclusion!.count).toBe(1);
  });
});

// ============================================================
// Different lenses produce different scores
// ============================================================

describe("Lens comparison: same data, different scores", () => {
  it("aibtc excludes non-approved clients; open lens includes all", async () => {
    await seedBase();

    // Create an "open" lens with no trust restrictions
    await env.DB.prepare(
      `INSERT INTO lenses (name, description, config) VALUES (
        'open',
        'Permissive pass-through lens for testing',
        '{"trust":{"approved_clients_only":false,"min_feedback_count_per_reviewer":0},"bounds":{"min_wad_value":null,"max_wad_value":null},"rate":{"max_per_reviewer_per_window":null,"window_blocks":144},"decay":{"enabled":false,"half_life_blocks":1440},"weight":{"enabled":false,"weight_by_reviewer_score":false}}'
      )`
    ).run();

    // Insert an agent and feedback from a non-approved client
    await env.DB.prepare(
      "INSERT INTO agents (agent_id, owner, created_at_block, created_at_tx) VALUES (96, 'SPTEST96', 1, '0xtx_test')"
    ).run();
    await env.DB.prepare(
      `INSERT INTO feedback (agent_id, client, feedback_index, value, value_decimals,
        wad_value, tag1, tag2, endpoint, feedback_uri, feedback_hash,
        is_revoked, created_at_block, created_at_tx)
       VALUES (96, 'SP_UNAPPROVED', 0, '5000000000000000000', '18',
        '5000000000000000000', 'quality', '', '', 'uri', 'hash96',
        0, 100, '0xtx1')`
    ).run();

    // aibtc score: client not in client_approvals, so score=0
    const aibtcRes = await getEndpoint("/lenses/aibtc/agents/96/score?block=200");
    expect(aibtcRes.status).toBe(200);
    const aibtcBody = await aibtcRes.json<{ score: string }>();
    expect(aibtcBody.score).toBe("0");

    // open lens score: accepts all clients, score should reflect the feedback
    const openRes = await getEndpoint("/lenses/open/agents/96/score?block=200");
    expect(openRes.status).toBe(200);
    const openBody = await openRes.json<{ score: string }>();
    // Non-zero score since the feedback passes through the open lens
    expect(openBody.score).not.toBe("0");
  });
});

// ============================================================
// Admin: POST /lenses
// ============================================================

describe("POST /api/v1/lenses (admin)", () => {
  it("returns 401 without admin token", async () => {
    await seedBase();
    const res = await postEndpoint("/lenses", { name: "test-lens" });
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong admin token", async () => {
    await seedBase();
    const res = await postEndpoint(
      "/lenses",
      { name: "test-lens" },
      "wrong-token"
    );
    expect(res.status).toBe(401);
  });

  it("creates a new lens with valid admin token", async () => {
    await seedBase();
    const res = await postEndpoint(
      "/lenses",
      {
        name: "my-lens",
        description: "A test lens",
        config: {
          trust: { approved_clients_only: false, min_feedback_count_per_reviewer: 2 },
        },
      },
      ADMIN_TOKEN
    );
    expect(res.status).toBe(201);
    const body = await res.json<{
      name: string;
      config: { trust: { min_feedback_count_per_reviewer: number } };
    }>();
    expect(body.name).toBe("my-lens");
    expect(body.config.trust.min_feedback_count_per_reviewer).toBe(2);
  });

  it("returns 409 when lens name already exists", async () => {
    await seedBase();
    // First creation
    const r1 = await postEndpoint(
      "/lenses",
      { name: "dup-lens" },
      ADMIN_TOKEN
    );
    expect(r1.status).toBe(201);
    // Duplicate
    const r2 = await postEndpoint(
      "/lenses",
      { name: "dup-lens" },
      ADMIN_TOKEN
    );
    expect(r2.status).toBe(409);
  });
});

// ============================================================
// Admin: PUT /lenses/:lens
// ============================================================

describe("PUT /api/v1/lenses/:lens (admin)", () => {
  it("returns 401 without admin token", async () => {
    await seedBase();
    const res = await putEndpoint("/lenses/aibtc", { config: {} });
    expect(res.status).toBe(401);
  });

  it("updates lens config with valid admin token", async () => {
    await seedBase();
    const res = await putEndpoint(
      "/lenses/aibtc",
      {
        config: {
          trust: { approved_clients_only: false, min_feedback_count_per_reviewer: 0 },
        },
      },
      ADMIN_TOKEN
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      name: string;
      config: { trust: { approved_clients_only: boolean } };
    }>();
    expect(body.name).toBe("aibtc");
    expect(body.config.trust.approved_clients_only).toBe(false);
  });

  it("returns 404 when updating non-existent lens", async () => {
    await seedBase();
    const res = await putEndpoint(
      "/lenses/doesnotexist",
      { config: {} },
      ADMIN_TOKEN
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================
// GET /lenses/:lens/agents/:id/feedback
// ============================================================

describe("GET /api/v1/lenses/:lens/agents/:id/feedback", () => {
  it("returns transparency metadata for lens feedback filter", async () => {
    await seedBase();
    await env.DB.prepare(
      "INSERT INTO agents (agent_id, owner, created_at_block, created_at_tx) VALUES (95, 'SPTEST95', 1, '0xtx_test')"
    ).run();
    const res = await getEndpoint("/lenses/aibtc/agents/95/feedback");
    expect(res.status).toBe(200);
    const body = await res.json<{
      agent_id: number;
      lens_name: string;
      included_count: number;
      excluded_count: number;
      exclusions: unknown[];
      flags: string[];
    }>();
    expect(body.agent_id).toBe(95);
    expect(body.lens_name).toBe("aibtc");
    expect(typeof body.included_count).toBe("number");
    expect(typeof body.excluded_count).toBe("number");
    expect(Array.isArray(body.exclusions)).toBe(true);
    expect(Array.isArray(body.flags)).toBe(true);
  });
});
