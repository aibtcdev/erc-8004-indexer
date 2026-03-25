/**
 * Integration tests for POST /webhook.
 *
 * Uses @cloudflare/vitest-pool-workers SELF binding to make real HTTP requests
 * against the worker. Each test sets up the DB schema and KV auth secret,
 * posts a fixture payload, then queries D1 to verify the expected rows.
 */
import { describe, it, expect } from "vitest";
import { SELF, env as rawEnv } from "cloudflare:test";
import type { Env } from "../types";
import { setupDb } from "./helpers";

// Cast the cloudflare:test env to our typed Env interface
const env = rawEnv as unknown as Env;

import applyIdentityFixture from "./fixtures/apply-identity.json";
import applyReputationFixture from "./fixtures/apply-reputation.json";
import applyValidationFixture from "./fixtures/apply-validation.json";

const TEST_SECRET = "test-webhook-secret";
const WEBHOOK_URL = "http://localhost/webhook";

async function postWebhook(
  body: unknown,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token !== undefined) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return SELF.fetch(WEBHOOK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function setup(): Promise<void> {
  await setupDb(env.DB);
  await env.INDEXER_KV.put("webhook_secret", TEST_SECRET);
}

// ============================================================
// Auth tests
// ============================================================

describe("POST /webhook — authentication", () => {
  it("returns 401 with missing Authorization header", async () => {
    await setup();
    const res = await postWebhook(applyIdentityFixture); // no token
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    await setup();
    const res = await postWebhook(applyIdentityFixture, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct token", async () => {
    await setup();
    const res = await postWebhook(applyIdentityFixture, TEST_SECRET);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });
});

// ============================================================
// Identity event tests
// ============================================================

describe("POST /webhook — identity events", () => {
  it("processes Registered event — inserts agent row", async () => {
    await setup();
    const res = await postWebhook(applyIdentityFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT * FROM agents WHERE agent_id = 1")
      .first<{ agent_id: number; owner: string; token_uri: string; created_at_tx: string }>();

    expect(row).not.toBeNull();
    expect(row!.agent_id).toBe(1);
    // After the full fixture, Transfer updates owner to the recipient;
    // verify the row was created (created_at_tx is from the Registered tx)
    expect(row!.created_at_tx).toBe("0xtx_registered");
    // token_uri was updated by UriUpdated event later in the same block
    expect(row!.token_uri).toBe("https://example.com/agent/1/v2");
  });

  it("processes MetadataSet event — inserts agent_metadata row", async () => {
    await setup();
    const res = await postWebhook(applyIdentityFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        "SELECT * FROM agent_metadata WHERE agent_id = 1 AND key = 'name'"
      )
      .first<{ agent_id: number; key: string; value_len: number }>();

    expect(row).not.toBeNull();
    expect(row!.key).toBe("name");
    expect(row!.value_len).toBe(10);
  });

  it("processes UriUpdated event — updates agents.token_uri", async () => {
    await setup();
    const res = await postWebhook(applyIdentityFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT token_uri, updated_at_block FROM agents WHERE agent_id = 1")
      .first<{ token_uri: string; updated_at_block: number }>();

    expect(row).not.toBeNull();
    expect(row!.token_uri).toBe("https://example.com/agent/1/v2");
    expect(row!.updated_at_block).toBe(100);
  });

  it("processes ApprovalForAll event — inserts approval row", async () => {
    await setup();
    const res = await postWebhook(applyIdentityFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        "SELECT * FROM approvals WHERE agent_id = 1 AND operator = 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE'"
      )
      .first<{ approved: number }>();

    expect(row).not.toBeNull();
    expect(row!.approved).toBe(1);
  });

  it("processes Transfer event — updates agents.owner", async () => {
    await setup();
    const res = await postWebhook(applyIdentityFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT owner FROM agents WHERE agent_id = 1")
      .first<{ owner: string }>();

    expect(row).not.toBeNull();
    expect(row!.owner).toBe("SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE");
  });
});

// ============================================================
// Reputation event tests
// ============================================================

describe("POST /webhook — reputation events", () => {
  it("processes ClientApproved event — inserts client_approval row", async () => {
    await setup();
    const res = await postWebhook(applyReputationFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        "SELECT * FROM client_approvals WHERE agent_id = 1 AND client = 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7'"
      )
      .first<{ index_limit: string }>();

    expect(row).not.toBeNull();
    expect(row!.index_limit).toBe("5");
  });

  it("processes NewFeedback event — inserts feedback row with wad_value", async () => {
    await setup();
    const res = await postWebhook(applyReputationFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        "SELECT * FROM feedback WHERE agent_id = 1 AND client = 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7' AND feedback_index = 0"
      )
      .first<{
        value: string;
        value_decimals: string;
        wad_value: string;
        tag1: string;
        is_revoked: number;
      }>();

    expect(row).not.toBeNull();
    expect(row!.value).toBe("5");
    expect(row!.value_decimals).toBe("0");
    // wad_value = 5 * 10^(18-0) = 5000000000000000000
    expect(row!.wad_value).toBe("5000000000000000000");
    expect(row!.tag1).toBe("quality");
  });

  it("processes FeedbackRevoked event — marks feedback is_revoked=1", async () => {
    await setup();
    const res = await postWebhook(applyReputationFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        "SELECT is_revoked, revoked_at_block FROM feedback WHERE agent_id = 1 AND feedback_index = 0"
      )
      .first<{ is_revoked: number; revoked_at_block: number }>();

    expect(row).not.toBeNull();
    expect(row!.is_revoked).toBe(1);
    expect(row!.revoked_at_block).toBe(101);
  });

  it("processes ResponseAppended event — inserts feedback_response row", async () => {
    await setup();
    const res = await postWebhook(applyReputationFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        "SELECT * FROM feedback_responses WHERE agent_id = 1 AND feedback_index = 0"
      )
      .first<{ responder: string; response_uri: string }>();

    expect(row).not.toBeNull();
    expect(row!.responder).toBe("SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE");
    expect(row!.response_uri).toBe("https://example.com/response/1");
  });
});

// ============================================================
// Validation event tests
// ============================================================

describe("POST /webhook — validation events", () => {
  it("processes ValidationRequest event — inserts validation_request row", async () => {
    await setup();
    const res = await postWebhook(applyValidationFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        "SELECT * FROM validation_requests WHERE request_hash = '1234567890123456789012345678901234567890123456789012345678901234'"
      )
      .first<{
        agent_id: number;
        validator: string;
        has_response: number;
        request_uri: string;
        created_at_tx: string;
      }>();

    expect(row).not.toBeNull();
    expect(row!.agent_id).toBe(1);
    expect(row!.validator).toBe("SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE");
    // The fixture contains both request and response in the same block;
    // after both process, has_response=1 (updated by ValidationResponse)
    expect(row!.has_response).toBe(1);
    expect(row!.request_uri).toBe("https://example.com/request/1");
    expect(row!.created_at_tx).toBe("0xtx_validationrequest");
  });

  it("processes ValidationResponse event — updates validation_request with response", async () => {
    await setup();
    const res = await postWebhook(applyValidationFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        "SELECT has_response, response, tag FROM validation_requests WHERE request_hash = '1234567890123456789012345678901234567890123456789012345678901234'"
      )
      .first<{ has_response: number; response: string; tag: string }>();

    expect(row).not.toBeNull();
    expect(row!.has_response).toBe(1);
    expect(row!.response).toBe("1");
    expect(row!.tag).toBe("approved");
  });
});

// ============================================================
// sync_state test
// ============================================================

describe("POST /webhook — sync_state", () => {
  it("updates sync_state after processing apply block", async () => {
    await setup();
    const res = await postWebhook(applyIdentityFixture, TEST_SECRET);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        "SELECT last_indexed_block FROM sync_state WHERE contract_id = 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2'"
      )
      .first<{ last_indexed_block: number }>();

    expect(row).not.toBeNull();
    expect(row!.last_indexed_block).toBe(100);
  });
});
