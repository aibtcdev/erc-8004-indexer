<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>
    Implement POST /webhook endpoint that receives Chainhooks 2.0 payloads, authenticates via
    bearer token, routes contract_log operations to the correct handler by contract_identifier,
    processes all 11 event types (identity 5 + reputation 4 + validation 2), handles rollbacks,
    and updates sync_state. All DB writes within transactions.
  </goal>

  <context>
    Codebase state after Phase 2:
    - src/index.ts: Hono app with CORS + logger middleware, root GET /, 404 + error handlers
    - src/types.ts: Env, Logger, LogsRPC, AppVariables — re-exports from src/types/index.ts
    - src/types/events.ts: 11-event discriminated union on `notification` field
    - src/types/db.ts: Row types for all 9 D1 tables
    - src/types/chainhook.ts: ChainhookEvent re-export, isContractLogOperation() guard,
      extractContractLogs() helper (apply only), isReprValue() guard
    - src/middleware/logger.ts: request-scoped Logger with RPC + console fallback
    - migrations/0001_initial.sql: all 9 tables with covering indexes
    - vitest.config.mts: @cloudflare/vitest-pool-workers, LOGS stubbed as Response("ok")

    Contract identifiers (mainnet):
    - identity:   SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2
    - reputation: SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2
    - validation: SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.validation-registry-v2

    Clarity print event repr format (decoded when decode_clarity_values=true):
    - Tuples: {agent-id: u1, notification: "identity-registry/Registered", payload: {...}}
    - uint128: u123 (parse by stripping leading "u")
    - int128: -123 or 123 (may be negative, no prefix)
    - bool: true | false
    - principal: SP... or 'SP... (strip leading quote)
    - buffer: 0x... (hex, strip 0x prefix)
    - string-utf8/string-ascii: "value" (quoted, strip quotes)

    The repr is a Clarity value string. The outer tuple has keys:
      notification: string literal (event discriminant)
      payload: inner tuple with event fields

    DB key design for agent_metadata:
    - The MetadataSet event only carries the key and value-len (not the value bytes).
    - value_hex is not available from the print event; store empty string for now.
    - The contract's actual value is in the metadata map, not the print event.

    Rollback strategy: DELETE FROM each table WHERE created_at_tx = ? (or revoked_at_tx = ?
    for feedback revocations, responded_at_tx = ? for validation responses).
    Actually: use block_height + tx_hash columns (created_at_block + created_at_tx) for
    precise rollback targeting per the schema.

    Bearer token auth: The webhook secret is stored in INDEXER_KV under key "webhook_secret".
    The request must include Authorization: Bearer {secret}. Returns 401 if missing or wrong.

    WAD normalization for NewFeedback: wad_value = value * 10^(18 - value_decimals).
    Store as string. Use BigInt arithmetic to avoid float precision issues.
    For negative values: negate, scale, then re-negate. Keep as signed string.
  </context>

  <task id="1">
    <name>Implement event handlers and event router</name>
    <files>
      src/handlers/index.ts,
      src/handlers/identity.ts,
      src/handlers/reputation.ts,
      src/handlers/validation.ts,
      src/handlers/rollback.ts
    </files>
    <action>
      Create src/handlers/ directory with five files.

      src/handlers/identity.ts — five handler functions, each taking
      (db: D1Database, event: SpecificEvent, blockHeight: number, txHash: string, logger: Logger):
        - handleRegistered: INSERT INTO agents (agent_id, owner, token_uri, created_at_block,
          created_at_tx) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO NOTHING
        - handleMetadataSet: INSERT INTO agent_metadata (agent_id, key, value_hex, value_len,
          set_at_block, set_at_tx) VALUES (?, ?, '', ?, ?, ?) ON CONFLICT(agent_id, key)
          DO UPDATE SET value_len=excluded.value_len, set_at_block=excluded.set_at_block,
          set_at_tx=excluded.set_at_tx
        - handleUriUpdated: UPDATE agents SET token_uri=?, updated_at_block=? WHERE agent_id=?
        - handleApprovalForAll: INSERT INTO approvals (agent_id, operator, approved,
          set_at_block, set_at_tx) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id, operator)
          DO UPDATE SET approved=excluded.approved, set_at_block=excluded.set_at_block,
          set_at_tx=excluded.set_at_tx
        - handleTransfer: UPDATE agents SET owner=?, updated_at_block=? WHERE agent_id=?
          (agent_id = token-id from event)

      src/handlers/reputation.ts — four handler functions:
        - handleClientApproved: INSERT INTO client_approvals (agent_id, client, index_limit,
          set_at_block, set_at_tx) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id, client)
          DO UPDATE SET index_limit=excluded.index_limit, set_at_block=excluded.set_at_block,
          set_at_tx=excluded.set_at_tx
        - handleNewFeedback: Compute wad_value via BigInt arithmetic
          (value * 10n^(18n - decimals_n), clamped if decimals > 18). INSERT INTO feedback
          (agent_id, client, feedback_index, value, value_decimals, wad_value, tag1, tag2,
          endpoint, feedback_uri, feedback_hash, is_revoked, created_at_block, created_at_tx)
          VALUES (...) ON CONFLICT(agent_id, client, feedback_index) DO NOTHING
        - handleFeedbackRevoked: UPDATE feedback SET is_revoked=1, revoked_at_block=?,
          revoked_at_tx=? WHERE agent_id=? AND client=? AND feedback_index=?
        - handleResponseAppended: INSERT INTO feedback_responses (agent_id, client,
          feedback_index, responder, response_uri, response_hash, created_at_block, created_at_tx)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)

      src/handlers/validation.ts — two handler functions:
        - handleValidationRequest: INSERT INTO validation_requests (request_hash, agent_id,
          validator, request_uri, has_response, created_at_block, created_at_tx)
          VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(request_hash) DO NOTHING
        - handleValidationResponse: UPDATE validation_requests SET has_response=1, response=?,
          response_uri=?, response_hash=?, tag=?, responded_at_block=?, responded_at_tx=?
          WHERE request_hash=?

      src/handlers/rollback.ts — one function handleRollback(db, blockHeight, txHash, logger):
        Deletes rows created by a specific transaction (for chain reorgs):
        - DELETE FROM agents WHERE created_at_block=? AND created_at_tx=?
        - DELETE FROM agent_metadata WHERE set_at_block=? AND set_at_tx=?
        - DELETE FROM approvals WHERE set_at_block=? AND set_at_tx=?
        - DELETE FROM feedback WHERE created_at_block=? AND created_at_tx=?
        - UPDATE feedback SET is_revoked=0, revoked_at_block=NULL, revoked_at_tx=NULL
          WHERE revoked_at_block=? AND revoked_at_tx=?
        - DELETE FROM client_approvals WHERE set_at_block=? AND set_at_tx=?
        - DELETE FROM feedback_responses WHERE created_at_block=? AND created_at_tx=?
        - DELETE FROM validation_requests WHERE created_at_block=? AND created_at_tx=?
        - UPDATE validation_requests SET has_response=0, response=NULL, response_uri=NULL,
          response_hash=NULL, tag=NULL, responded_at_block=NULL, responded_at_tx=NULL
          WHERE responded_at_block=? AND responded_at_tx=?
        Execute all as batch (db.batch([...statements])).

      src/handlers/index.ts — event router:
        Export routeEvent(db, contractId, reprValue, blockHeight, txHash, logger):
        1. Parse the repr string to extract the outer tuple's notification and payload fields.
        2. Build a typed Erc8004Event object from the notification + payload.
        3. Dispatch to the correct handler based on notification string.
        4. Return a result indicating success or unrecognized event.

        repr parsing approach: The repr string is Clarity tuple syntax like:
          {agent-id: u1, notification: "identity-registry/Registered", payload: {owner: SP..., ...}}
        Parse the notification field first (find 'notification: "..."' pattern via regex).
        Parse payload fields with a simple key-value extractor:
          - uint: strip leading 'u' -> string
          - int: as-is string (may start with -)
          - bool: 'true' | 'false' -> boolean
          - principal: strip optional leading quote (') -> string
          - buffer: strip '0x' prefix -> string
          - string: strip surrounding double quotes -> string

        Expose parseRepr(repr: string): Record&lt;string, unknown&gt; helper.
    </action>
    <verify>
      cd /home/whoabuddy/dev/aibtcdev/erc-8004-indexer
      npx tsc --noEmit 2>&amp;1 | head -30
    </verify>
    <done>
      All five handler files exist with substantive implementations. TypeScript compiles
      without errors.
    </done>
  </task>

  <task id="2">
    <name>Implement POST /webhook route and wire into Hono app</name>
    <files>
      src/webhook.ts,
      src/index.ts
    </files>
    <action>
      Create src/webhook.ts:

      Export async function webhookHandler(c: Context&lt;{Bindings: Env; Variables: AppVariables}&gt;):
      1. Auth: Read Authorization header, extract Bearer token. Read "webhook_secret" from
         c.env.INDEXER_KV. If KV returns null (not set), allow through with a warning log.
         If KV has a secret and token doesn't match, return c.json({error:"Unauthorized"}, 401).
      2. Parse body: const payload = await c.req.json() as ChainhookEvent
      3. Get logger from c.var.logger
      4. Contract IDs:
           IDENTITY_CONTRACT = "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2"
           REPUTATION_CONTRACT = "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2"
           VALIDATION_CONTRACT = "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.validation-registry-v2"
         const WATCHED = [IDENTITY_CONTRACT, REPUTATION_CONTRACT, VALIDATION_CONTRACT]
      5. Process apply blocks: for each block in payload.event.apply:
           for each tx in block.transactions:
             for each op in tx.operations:
               if isContractLogOperation(op) and WATCHED.includes(op.metadata.contract_identifier):
                 if isReprValue(op.metadata.value):
                   await routeEvent(db, contractId, op.metadata.value.repr, blockHeight, txHash, logger)
      6. Process rollback blocks: for each block in payload.event.rollback:
           for each tx in block.transactions:
             await handleRollback(db, blockHeight, txHash, logger)
      7. Update sync_state for each watched contract that appeared in apply blocks:
         INSERT INTO sync_state (contract_id, last_indexed_block, last_indexed_tx, updated_at)
         VALUES (?, ?, ?, datetime('now')) ON CONFLICT(contract_id) DO UPDATE SET
         last_indexed_block=excluded.last_indexed_block,
         last_indexed_tx=excluded.last_indexed_tx,
         updated_at=excluded.updated_at
         Only update if the new block height is >= existing.
      8. Return c.json({ok: true}, 200)

      In src/index.ts, add:
        import { webhookRoute } from "./webhook";
        app.post("/webhook", webhookRoute);
      (Move handler logic into webhook.ts, expose as Hono route handler or use app.route)
    </action>
    <verify>
      cd /home/whoabuddy/dev/aibtcdev/erc-8004-indexer
      npx tsc --noEmit 2>&amp;1 | head -30
      npm run deploy:dry-run 2>&amp;1 | tail -20
    </verify>
    <done>
      src/webhook.ts exists with bearer auth, apply/rollback processing, sync_state updates.
      POST /webhook is registered in src/index.ts. TypeScript compiles clean. Dry-run succeeds.
    </done>
  </task>

  <task id="3">
    <name>Write integration tests for webhook and rollback</name>
    <files>
      src/__tests__/webhook.test.ts,
      src/__tests__/rollback.test.ts,
      src/__tests__/fixtures/apply-identity.json,
      src/__tests__/fixtures/apply-reputation.json,
      src/__tests__/fixtures/apply-validation.json,
      src/__tests__/fixtures/rollback-block.json
    </files>
    <action>
      Create fixture JSON files with realistic chainhook payloads:

      fixtures/apply-identity.json — ChainhookEvent with apply block containing 5 transactions,
      one per identity event type (Registered, MetadataSet, UriUpdated, ApprovalForAll, Transfer).
      Each tx has one contract_log operation with the identity-registry-v2 contract_identifier
      and a repr value matching the event shape.

      fixtures/apply-reputation.json — ChainhookEvent with apply block containing 4 transactions
      for: NewFeedback, FeedbackRevoked (after inserting one first), ResponseAppended,
      ClientApproved.

      fixtures/apply-validation.json — ChainhookEvent with apply block containing 2 transactions
      for: ValidationRequest and ValidationResponse.

      fixtures/rollback-block.json — ChainhookEvent with empty apply and one rollback block
      containing a transaction that matches block_height=100 and a test tx hash.

      Test structure (using @cloudflare/vitest-pool-workers):
      Import { env, createExecutionContext, waitOnExecutionContext } from
      "cloudflare:test" for accessing D1 binding.

      For each test:
      1. Run migration SQL against the test D1 using env.DB.exec() or db.prepare().run()
      2. POST to SELF with fixture payload and Authorization: Bearer test-secret
         (set "webhook_secret" in INDEXER_KV first via env.INDEXER_KV.put())
      3. Assert response is 200
      4. Query DB to verify rows were inserted

      webhook.test.ts:
        - "returns 401 with missing Authorization"
        - "returns 401 with wrong token"
        - "processes Registered event — inserts agent row"
        - "processes MetadataSet event — inserts agent_metadata row"
        - "processes UriUpdated event — updates agents.token_uri"
        - "processes ApprovalForAll event — inserts approval row"
        - "processes Transfer event — updates agents.owner"
        - "processes NewFeedback event — inserts feedback row with wad_value"
        - "processes ClientApproved event — inserts client_approval row"
        - "processes FeedbackRevoked event — marks feedback is_revoked=1"
        - "processes ResponseAppended event — inserts feedback_response row"
        - "processes ValidationRequest event — inserts validation_request row"
        - "processes ValidationResponse event — updates validation_request with response"
        - "updates sync_state after apply block"

      rollback.test.ts:
        - "rollback deletes agents row at block/tx"
        - "rollback deletes feedback row at block/tx"
        - "rollback unrevokes feedback when revocation is rolled back"
        - "rollback deletes validation_request at block/tx"
        - "rollback unsets validation response when response tx is rolled back"

      Use the SELF fetch binding for end-to-end tests (POST to the actual worker).
      Import migration SQL directly using ?raw Vite import or inline the CREATE TABLE
      statements in a helper setupDb() function that runs all DDL.
    </action>
    <verify>
      cd /home/whoabuddy/dev/aibtcdev/erc-8004-indexer
      npm test 2>&amp;1 | tail -40
    </verify>
    <done>
      All test files exist and npm test passes (or exits with a known vitest pool error
      acceptable for local environments). At minimum, TypeScript compiles and tests are
      substantive (not stubs).
    </done>
  </task>
</plan>
