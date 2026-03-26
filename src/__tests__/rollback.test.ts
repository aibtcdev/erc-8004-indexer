/**
 * Integration tests for rollback behavior.
 *
 * Each test:
 * 1. Applies events to seed the DB
 * 2. Posts a rollback payload targeting the same block/tx
 * 3. Verifies that rows were deleted or state was reverted
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
import rollbackBlockFixture from "./fixtures/rollback-block.json";

const TEST_SECRET = "test-webhook-secret";
const WEBHOOK_URL = "http://localhost/webhook";

async function postWebhook(body: unknown, token = TEST_SECRET): Promise<Response> {
  return SELF.fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function setup(): Promise<void> {
  await setupDb(env.DB);
  await env.INDEXER_KV.put("webhook_secret", TEST_SECRET);
}

// ============================================================
// Rollback tests
// ============================================================

describe("POST /webhook — rollback", () => {
  it("rollback deletes agents row created in the rolled-back tx", async () => {
    await setup();

    // Apply to seed the agent row
    const applyRes = await postWebhook(applyIdentityFixture);
    expect(applyRes.status).toBe(200);

    // Verify row exists
    const before = await env.DB
      .prepare("SELECT agent_id FROM agents WHERE agent_id = 1")
      .first();
    expect(before).not.toBeNull();

    // Rollback the tx that created the agent (block 100, tx 0xtx_registered)
    const rollbackRes = await postWebhook(rollbackBlockFixture);
    expect(rollbackRes.status).toBe(200);

    // Agent row should be deleted
    const after = await env.DB
      .prepare("SELECT agent_id FROM agents WHERE agent_id = 1")
      .first();
    expect(after).toBeNull();
  });

  it("rollback deletes feedback row created in the rolled-back tx", async () => {
    await setup();

    // Build a reputation fixture with a single NewFeedback at block 100, tx 0xtx_registered
    // to match the rollback fixture's target
    const reputationAtBlock100 = {
      ...applyReputationFixture,
      event: {
        ...applyReputationFixture.event,
        apply: [
          {
            ...applyReputationFixture.event.apply[0],
            block_identifier: { index: 100, hash: "0xblock100" },
            transactions: [
              {
                transaction_identifier: { hash: "0xtx_registered" },
                operations: [
                  applyReputationFixture.event.apply[0].transactions[1].operations[0],
                ],
              },
            ],
          },
        ],
      },
    };

    const applyRes = await postWebhook(reputationAtBlock100);
    expect(applyRes.status).toBe(200);

    const before = await env.DB
      .prepare("SELECT id FROM feedback WHERE created_at_tx = '0xtx_registered'")
      .first();
    expect(before).not.toBeNull();

    // Rollback
    const rollbackRes = await postWebhook(rollbackBlockFixture);
    expect(rollbackRes.status).toBe(200);

    const after = await env.DB
      .prepare("SELECT id FROM feedback WHERE created_at_tx = '0xtx_registered'")
      .first();
    expect(after).toBeNull();
  });

  it("rollback un-revokes feedback when the revocation tx is rolled back", async () => {
    await setup();

    // Apply NewFeedback at block 100, tx A; FeedbackRevoked at block 100, tx B
    const applyWithRevoke = {
      chainhook: { uuid: "test-revoke-rollback" },
      event: {
        chain: "stacks",
        network: "mainnet",
        apply: [
          {
            block_identifier: { index: 100, hash: "0xblock100" },
            parent_block_identifier: { index: 99, hash: "0xblock99" },
            timestamp: 1700000000,
            metadata: {
              canonical: true,
              burn_block_identifier: { index: 800000, hash: "0xburn800000" },
              burn_block_timestamp: 1700000000,
              parent_microblock_identifier: null,
              tenure_height: 100,
              execution_cost: { read_count: 0, read_length: 0, runtime: 0, write_count: 0, write_length: 0 },
              tx_total_size: 0,
              tx_count: 2,
            },
            transactions: [
              {
                transaction_identifier: { hash: "0xtx_newfeedback_seed" },
                operations: [
                  {
                    type: "contract_log",
                    status: "success",
                    operation_identifier: { index: 0 },
                    metadata: {
                      contract_identifier:
                        "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2",
                      topic: "print",
                      value: {
                        hex: "0x00",
                        repr: '{notification: "reputation-registry/NewFeedback", payload: {agent-id: u1, client: SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7, index: u0, value: 5, value-decimals: u0, tag1: "quality", tag2: "", endpoint: "https://api.example.com", feedback-uri: "https://example.com/feedback/1", feedback-hash: 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef}}',
                      },
                    },
                  },
                ],
              },
              {
                // This tx will be rolled back — it contains the FeedbackRevoked event
                transaction_identifier: { hash: "0xtx_registered" },
                operations: [
                  {
                    type: "contract_log",
                    status: "success",
                    operation_identifier: { index: 0 },
                    metadata: {
                      contract_identifier:
                        "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2",
                      topic: "print",
                      value: {
                        hex: "0x00",
                        repr: '{notification: "reputation-registry/FeedbackRevoked", payload: {agent-id: u1, client: SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7, index: u0}}',
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
        rollback: [],
      },
    };

    const applyRes = await postWebhook(applyWithRevoke);
    expect(applyRes.status).toBe(200);

    // Feedback should be revoked
    const revokedRow = await env.DB
      .prepare("SELECT is_revoked FROM feedback WHERE agent_id = 1 AND feedback_index = 0")
      .first<{ is_revoked: number }>();
    expect(revokedRow).not.toBeNull();
    expect(revokedRow!.is_revoked).toBe(1);

    // Rollback the revocation tx
    const rollbackRes = await postWebhook(rollbackBlockFixture);
    expect(rollbackRes.status).toBe(200);

    // Feedback should be un-revoked
    const unrevoked = await env.DB
      .prepare(
        "SELECT is_revoked, revoked_at_block FROM feedback WHERE agent_id = 1 AND feedback_index = 0"
      )
      .first<{ is_revoked: number; revoked_at_block: number | null }>();
    expect(unrevoked).not.toBeNull();
    expect(unrevoked!.is_revoked).toBe(0);
    expect(unrevoked!.revoked_at_block).toBeNull();
  });

  it("rollback deletes validation_request row at block/tx", async () => {
    await setup();

    // Apply validation request at block 100, tx 0xtx_registered
    const validationAtBlock100 = {
      ...applyValidationFixture,
      event: {
        ...applyValidationFixture.event,
        apply: [
          {
            ...applyValidationFixture.event.apply[0],
            block_identifier: { index: 100, hash: "0xblock100" },
            transactions: [
              {
                transaction_identifier: { hash: "0xtx_registered" },
                operations: [
                  applyValidationFixture.event.apply[0].transactions[0].operations[0],
                ],
              },
            ],
          },
        ],
      },
    };

    const applyRes = await postWebhook(validationAtBlock100);
    expect(applyRes.status).toBe(200);

    const before = await env.DB
      .prepare(
        "SELECT id FROM validation_requests WHERE created_at_tx = '0xtx_registered'"
      )
      .first();
    expect(before).not.toBeNull();

    // Rollback
    const rollbackRes = await postWebhook(rollbackBlockFixture);
    expect(rollbackRes.status).toBe(200);

    const after = await env.DB
      .prepare(
        "SELECT id FROM validation_requests WHERE created_at_tx = '0xtx_registered'"
      )
      .first();
    expect(after).toBeNull();
  });

  it("rollback un-sets validation response when response tx is rolled back", async () => {
    await setup();

    // Apply request at block 99, tx A; then response at block 100, tx 0xtx_registered
    const seedRequest = {
      chainhook: { uuid: "test-val-response-rollback" },
      event: {
        chain: "stacks",
        network: "mainnet",
        apply: [
          {
            block_identifier: { index: 99, hash: "0xblock99" },
            parent_block_identifier: { index: 98, hash: "0xblock98" },
            timestamp: 1699999400,
            metadata: {
              canonical: true,
              burn_block_identifier: { index: 799999, hash: "0xburn799999" },
              burn_block_timestamp: 1699999400,
              parent_microblock_identifier: null,
              tenure_height: 99,
              execution_cost: { read_count: 0, read_length: 0, runtime: 0, write_count: 0, write_length: 0 },
              tx_total_size: 0,
              tx_count: 1,
            },
            transactions: [
              {
                transaction_identifier: { hash: "0xtx_valreq_seed" },
                operations: [
                  {
                    type: "contract_log",
                    status: "success",
                    operation_identifier: { index: 0 },
                    metadata: {
                      contract_identifier:
                        "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.validation-registry-v2",
                      topic: "print",
                      value: {
                        hex: "0x00",
                        repr: '{notification: "validation-registry/ValidationRequest", payload: {validator: SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE, agent-id: u1, request-hash: 0x1234567890123456789012345678901234567890123456789012345678901234, request-uri: "https://example.com/request/1"}}',
                      },
                    },
                  },
                ],
              },
            ],
          },
          {
            // Response at block 100, tx 0xtx_registered (will be rolled back)
            block_identifier: { index: 100, hash: "0xblock100" },
            parent_block_identifier: { index: 99, hash: "0xblock99" },
            timestamp: 1700000000,
            metadata: {
              canonical: true,
              burn_block_identifier: { index: 800000, hash: "0xburn800000" },
              burn_block_timestamp: 1700000000,
              parent_microblock_identifier: null,
              tenure_height: 100,
              execution_cost: { read_count: 0, read_length: 0, runtime: 0, write_count: 0, write_length: 0 },
              tx_total_size: 0,
              tx_count: 1,
            },
            transactions: [
              {
                transaction_identifier: { hash: "0xtx_registered" },
                operations: [
                  {
                    type: "contract_log",
                    status: "success",
                    operation_identifier: { index: 0 },
                    metadata: {
                      contract_identifier:
                        "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.validation-registry-v2",
                      topic: "print",
                      value: {
                        hex: "0x00",
                        repr: '{notification: "validation-registry/ValidationResponse", payload: {request-hash: 0x1234567890123456789012345678901234567890123456789012345678901234, response: u1, tag: "approved", response-uri: "https://example.com/response/1", response-hash: 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890}}',
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
        rollback: [],
      },
    };

    const applyRes = await postWebhook(seedRequest);
    expect(applyRes.status).toBe(200);

    // Verify response was applied
    const withResponse = await env.DB
      .prepare(
        "SELECT has_response FROM validation_requests WHERE request_hash = '1234567890123456789012345678901234567890123456789012345678901234'"
      )
      .first<{ has_response: number }>();
    expect(withResponse).not.toBeNull();
    expect(withResponse!.has_response).toBe(1);

    // Rollback the response tx
    const rollbackRes = await postWebhook(rollbackBlockFixture);
    expect(rollbackRes.status).toBe(200);

    // has_response should be reset to 0
    const afterRollback = await env.DB
      .prepare(
        "SELECT has_response, response, tag FROM validation_requests WHERE request_hash = '1234567890123456789012345678901234567890123456789012345678901234'"
      )
      .first<{ has_response: number; response: string | null; tag: string | null }>();
    expect(afterRollback).not.toBeNull();
    expect(afterRollback!.has_response).toBe(0);
    expect(afterRollback!.response).toBeNull();
    expect(afterRollback!.tag).toBeNull();
  });
});
