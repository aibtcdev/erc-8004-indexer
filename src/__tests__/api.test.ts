/**
 * Integration tests for GET /api/v1/* query endpoints.
 *
 * Strategy: seed D1 by posting all three fixture webhooks, then query
 * each REST endpoint and verify response shapes and data values.
 *
 * Fixtures produce:
 *   - 1 agent (agent_id=1, owner=SP3FBR2...)
 *   - 1 agent_metadata entry (key="name")
 *   - 1 client_approval (client=SP2J6..., index_limit="5")
 *   - 1 feedback entry (revoked) with wad_value="5000000000000000000"
 *   - 1 feedback_response
 *   - 1 validation_request (has_response=1, response="1", tag="approved")
 */
import { describe, it, expect } from "vitest";
import { SELF, env as rawEnv } from "cloudflare:test";
import type { Env } from "../types";
import { setupDb, clearData } from "./helpers";

import applyIdentityFixture from "./fixtures/apply-identity.json";
import applyReputationFixture from "./fixtures/apply-reputation.json";
import applyValidationFixture from "./fixtures/apply-validation.json";

const env = rawEnv as unknown as Env;

const TEST_SECRET = "test-api-secret";
const WEBHOOK_URL = "http://localhost/webhook";
const BASE_URL = "http://localhost/api/v1";

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

/**
 * Seed the database with all three fixture webhooks.
 * Called at the start of each test — clears existing data first to prevent
 * accumulation across tests that share the same D1 binding instance.
 */
async function seedAll(): Promise<void> {
  await setupDb(env.DB);
  await clearData(env.DB);
  await env.INDEXER_KV.put("webhook_secret", TEST_SECRET);

  const res1 = await postWebhook(applyIdentityFixture);
  if (!res1.ok) throw new Error(`Identity fixture failed: ${res1.status}`);

  const res2 = await postWebhook(applyReputationFixture);
  if (!res2.ok) throw new Error(`Reputation fixture failed: ${res2.status}`);

  const res3 = await postWebhook(applyValidationFixture);
  if (!res3.ok) throw new Error(`Validation fixture failed: ${res3.status}`);
}

// ============================================================
// Status and stats
// ============================================================

describe("GET /api/v1/status", () => {
  it("returns status ok with version and timestamp", async () => {
    await seedAll();
    const res = await getEndpoint("/status");
    expect(res.status).toBe(200);
    const body = await res.json<{
      status: string;
      version: string;
      timestamp: string;
      sync_state: unknown[];
    }>();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.timestamp).toBe("string");
    expect(Array.isArray(body.sync_state)).toBe(true);
    // After seeding identity + reputation + validation, there should be sync_state entries
    expect(body.sync_state.length).toBeGreaterThan(0);
  });
});

describe("GET /api/v1/stats", () => {
  it("returns global counts after seeding all fixtures", async () => {
    await seedAll();
    const res = await getEndpoint("/stats");
    expect(res.status).toBe(200);
    const body = await res.json<{
      agents: number;
      feedback: number;
      validations: number;
    }>();
    expect(body.agents).toBe(1);
    expect(body.feedback).toBe(1);
    expect(body.validations).toBe(1);
  });
});

// ============================================================
// Agents
// ============================================================

describe("GET /api/v1/agents", () => {
  it("returns paginated agent list", async () => {
    await seedAll();
    const res = await getEndpoint("/agents");
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { agent_id: number }[];
      pagination: { limit: number; offset: number; total: number };
    }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    expect(body.pagination.limit).toBe(50);
    expect(body.pagination.offset).toBe(0);
  });

  it("enforces custom limit and offset in pagination", async () => {
    await seedAll();
    const res = await getEndpoint("/agents?limit=1&offset=0");
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: unknown[];
      pagination: { limit: number; offset: number };
    }>();
    expect(body.pagination.limit).toBe(1);
    expect(body.pagination.offset).toBe(0);
  });

  it("caps limit at 200", async () => {
    await seedAll();
    const res = await getEndpoint("/agents?limit=999");
    expect(res.status).toBe(200);
    const body = await res.json<{
      pagination: { limit: number };
    }>();
    expect(body.pagination.limit).toBe(200);
  });
});

describe("GET /api/v1/agents/:id", () => {
  it("returns agent object for agent_id=1", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1");
    expect(res.status).toBe(200);
    const body = await res.json<{ agent_id: number; owner: string }>();
    expect(body.agent_id).toBe(1);
    expect(typeof body.owner).toBe("string");
  });

  it("returns 404 for non-existent agent", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/999");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("Not Found");
  });
});

describe("GET /api/v1/agents/:id/metadata", () => {
  it("returns metadata array for agent_id=1", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/metadata");
    expect(res.status).toBe(200);
    const body = await res.json<{ key: string; value_len: number }[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const nameEntry = body.find((m) => m.key === "name");
    expect(nameEntry).toBeDefined();
    expect(nameEntry!.value_len).toBe(10);
  });

  it("returns empty array for agent with no metadata", async () => {
    await setupDb(env.DB);
    // Insert a bare agent with no metadata
    await env.DB.prepare(
      "INSERT INTO agents (agent_id, owner, created_at_block, created_at_tx) VALUES (42, 'SPTEST', 1, '0xtx_test')"
    ).run();
    const res = await getEndpoint("/agents/42/metadata");
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

// ============================================================
// Feedback summary
// ============================================================

describe("GET /api/v1/agents/:id/summary", () => {
  it("returns feedback summary with correct counts", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/summary");
    expect(res.status).toBe(200);
    const body = await res.json<{
      agent_id: number;
      total_count: number;
      active_count: number;
      revoked_count: number;
      wad_sum: string;
    }>();
    expect(body.agent_id).toBe(1);
    // Reputation fixture gives 1 feedback then revokes it
    expect(body.total_count).toBe(1);
    expect(body.revoked_count).toBe(1);
    expect(body.active_count).toBe(0);
    // No active entries so wad_sum should be "0"
    expect(body.wad_sum).toBe("0");
  });

  it("supports tag1 filter on summary", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/summary?tag1=quality");
    expect(res.status).toBe(200);
    const body = await res.json<{ total_count: number }>();
    expect(body.total_count).toBe(1);
  });

  it("returns zero counts for non-matching filter", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/summary?tag1=nonexistent");
    expect(res.status).toBe(200);
    const body = await res.json<{ total_count: number }>();
    expect(body.total_count).toBe(0);
  });
});

// ============================================================
// Feedback list
// ============================================================

describe("GET /api/v1/agents/:id/feedback", () => {
  it("returns paginated feedback list", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/feedback");
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { agent_id: number; is_revoked: number }[];
      pagination: { total: number };
    }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination.total).toBe(1);
    expect(body.data[0].agent_id).toBe(1);
    expect(body.data[0].is_revoked).toBe(1);
  });

  it("filters by client", async () => {
    await seedAll();
    const client = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";
    const res = await getEndpoint(`/agents/1/feedback?client=${client}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ pagination: { total: number } }>();
    expect(body.pagination.total).toBe(1);
  });

  it("returns empty list for non-matching client filter", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/feedback?client=SPNONEXISTENT");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; pagination: { total: number } }>();
    expect(body.data.length).toBe(0);
    expect(body.pagination.total).toBe(0);
  });
});

describe("GET /api/v1/agents/:id/feedback/:seq", () => {
  it("returns feedback entries at a given index", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/feedback/0");
    expect(res.status).toBe(200);
    const body = await res.json<{ feedback_index: number }[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].feedback_index).toBe(0);
  });

  it("returns empty array for non-existent seq", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/feedback/999");
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

// ============================================================
// Clients
// ============================================================

describe("GET /api/v1/agents/:id/clients", () => {
  it("returns approved clients list", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/clients");
    expect(res.status).toBe(200);
    const body = await res.json<{ client: string; index_limit: string }[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].client).toBe("SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7");
    expect(body[0].index_limit).toBe("5");
  });
});

// ============================================================
// Feedback responses
// ============================================================

describe("GET /api/v1/agents/:id/feedback/:client/:index/responses", () => {
  it("returns responses for a specific feedback entry", async () => {
    await seedAll();
    const client = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";
    const res = await getEndpoint(`/agents/1/feedback/${client}/0/responses`);
    expect(res.status).toBe(200);
    const body = await res.json<{ responder: string }[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].responder).toBe("SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE");
  });

  it("returns empty array for feedback with no responses", async () => {
    await seedAll();
    const client = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";
    const res = await getEndpoint(`/agents/1/feedback/${client}/99/responses`);
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

// ============================================================
// Recent feedback
// ============================================================

describe("GET /api/v1/feedback/recent", () => {
  it("returns recent feedback across all agents", async () => {
    await seedAll();
    const res = await getEndpoint("/feedback/recent");
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { agent_id: number }[];
      pagination: { total: number };
    }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination.total).toBeGreaterThan(0);
    expect(body.data.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Validations
// ============================================================

describe("GET /api/v1/agents/:id/validations/summary", () => {
  it("returns validation summary with correct counts", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/validations/summary");
    expect(res.status).toBe(200);
    const body = await res.json<{
      agent_id: number;
      total: number;
      pending: number;
      responded: number;
    }>();
    expect(body.agent_id).toBe(1);
    expect(body.total).toBe(1);
    // Fixture includes both request and response — has_response=1
    expect(body.responded).toBe(1);
    expect(body.pending).toBe(0);
  });
});

describe("GET /api/v1/agents/:id/validations", () => {
  it("returns paginated validation list", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/validations");
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { agent_id: number; has_response: number }[];
      pagination: { total: number };
    }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination.total).toBe(1);
    expect(body.data[0].agent_id).toBe(1);
    expect(body.data[0].has_response).toBe(1);
  });

  it("filters by has_response=true", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/validations?has_response=true");
    expect(res.status).toBe(200);
    const body = await res.json<{ pagination: { total: number } }>();
    expect(body.pagination.total).toBe(1);
  });

  it("returns empty when filtering by has_response=false (none pending)", async () => {
    await seedAll();
    const res = await getEndpoint("/agents/1/validations?has_response=false");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; pagination: { total: number } }>();
    expect(body.pagination.total).toBe(0);
    expect(body.data.length).toBe(0);
  });
});

describe("GET /api/v1/validators/:addr/requests", () => {
  it("returns validation requests assigned to a validator", async () => {
    await seedAll();
    const validator = "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE";
    const res = await getEndpoint(`/validators/${validator}/requests`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { validator: string }[];
      pagination: { total: number };
    }>();
    expect(body.pagination.total).toBe(1);
    expect(body.data[0].validator).toBe(validator);
  });
});

describe("GET /api/v1/validations/:hash", () => {
  it("returns validation by request_hash", async () => {
    await seedAll();
    const hash =
      "1234567890123456789012345678901234567890123456789012345678901234";
    const res = await getEndpoint(`/validations/${hash}`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      request_hash: string;
      agent_id: number;
      has_response: number;
      response: string;
      tag: string;
    }>();
    expect(body.request_hash).toBe(hash);
    expect(body.agent_id).toBe(1);
    expect(body.has_response).toBe(1);
    expect(body.response).toBe("1");
    expect(body.tag).toBe("approved");
  });

  it("returns 404 for non-existent hash", async () => {
    await seedAll();
    const res = await getEndpoint(
      "/validations/0000000000000000000000000000000000000000000000000000000000000000"
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("Not Found");
  });
});
