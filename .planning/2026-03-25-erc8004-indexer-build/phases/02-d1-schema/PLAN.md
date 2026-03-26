<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Create D1 migration with all tables/indexes and TypeScript type definitions for DB rows, ERC-8004 events, and chainhook webhook payloads.</goal>
  <context>
    Phase 1 created the project scaffold. The wrangler.jsonc already defines a D1 binding named DB
    with migrations_dir "migrations". The src/types.ts defines Env (with DB: D1Database),
    Logger, and AppVariables.

    Contracts inspected:
    - identity-registry-v2: emits Registered, MetadataSet, UriUpdated (set-agent-uri), ApprovalForAll,
      Transfer, and wallet set/unset events. NFT = agent-identity (uint128 token-id = agent-id).
    - reputation-registry-v2: emits NewFeedback, FeedbackRevoked, ResponseAppended, ClientApproved events.
      Feedback has value (int128 = WAD), value-decimals (uint128), wad-value (int128 normalized to 18dp).
    - validation-registry-v2: emits ValidationRequest, ValidationResponse events.

    Actual event notification strings observed from mainnet:
    - "identity-registry/Registered"      → payload: {agent-id, owner, token-uri, metadata-count}
    - "identity-registry/MetadataSet"      → payload: {agent-id, key, value-len}
    - "identity-registry/UriUpdated"       → payload: {agent-id, new-uri}  (inferred from set-agent-uri)
    - "identity-registry/ApprovalForAll"   → payload: {agent-id, operator, approved}
    - "identity-registry/Transfer"         → payload: {token-id, sender, recipient}
    - "reputation-registry/NewFeedback"    → payload: {agent-id, client, index, value, value-decimals, tag1, tag2, endpoint, feedback-uri, feedback-hash}
    - "reputation-registry/FeedbackRevoked"→ payload: {agent-id, client, index}
    - "reputation-registry/ResponseAppended"→payload: {agent-id, client, index, responder, response-uri, response-hash}
    - "reputation-registry/ClientApproved" → payload: {agent-id, client, index-limit}
    - "validation-registry/ValidationRequest" → payload: {validator, agent-id, request-hash, request-uri}
    - "validation-registry/ValidationResponse"→ payload: {request-hash, response, tag, response-uri, response-hash}

    WAD values (int128/uint128) must be stored as TEXT in SQLite to avoid i64 overflow.
    @hirosystems/chainhooks-client v2.1.1 exports ChainhookEvent, StacksBlock, StacksContractLogOperation.

    Tables needed (7): agents, agent_metadata, approvals, feedback, client_approvals,
    feedback_responses, validation_requests, sync_state. Plus a lenses table (empty stub for future use).
  </context>

  <task id="1">
    <name>Create D1 migration SQL</name>
    <files>migrations/0001_initial.sql</files>
    <action>
      Create migrations/0001_initial.sql with all tables and indexes.

      Tables:
      1. agents — stores registered agent identities
         - agent_id INTEGER PRIMARY KEY (uint128 fits in SQLite int up to 2^63 which is fine for agent count)
         - owner TEXT NOT NULL
         - token_uri TEXT
         - created_at_block INTEGER NOT NULL
         - created_at_tx TEXT NOT NULL
         - updated_at_block INTEGER

      2. agent_metadata — key/value metadata per agent
         - id INTEGER PRIMARY KEY AUTOINCREMENT
         - agent_id INTEGER NOT NULL
         - key TEXT NOT NULL
         - value_hex TEXT NOT NULL  (hex-encoded buffer)
         - value_len INTEGER NOT NULL
         - set_at_block INTEGER NOT NULL
         - set_at_tx TEXT NOT NULL
         - UNIQUE(agent_id, key)

      3. approvals — approval-for-all grants
         - id INTEGER PRIMARY KEY AUTOINCREMENT
         - agent_id INTEGER NOT NULL
         - operator TEXT NOT NULL
         - approved INTEGER NOT NULL  (0 or 1 — SQLite boolean)
         - set_at_block INTEGER NOT NULL
         - set_at_tx TEXT NOT NULL
         - UNIQUE(agent_id, operator)

      4. feedback — reputation feedback entries
         - id INTEGER PRIMARY KEY AUTOINCREMENT
         - agent_id INTEGER NOT NULL
         - client TEXT NOT NULL
         - feedback_index INTEGER NOT NULL  (per-client index from contract)
         - value TEXT NOT NULL             (int128 as TEXT — WAD)
         - value_decimals TEXT NOT NULL    (uint128 as TEXT)
         - wad_value TEXT NOT NULL         (int128 as TEXT — normalized to 18dp)
         - tag1 TEXT NOT NULL
         - tag2 TEXT NOT NULL
         - endpoint TEXT NOT NULL
         - feedback_uri TEXT NOT NULL
         - feedback_hash TEXT NOT NULL     (hex)
         - is_revoked INTEGER NOT NULL DEFAULT 0
         - created_at_block INTEGER NOT NULL
         - created_at_tx TEXT NOT NULL
         - revoked_at_block INTEGER
         - revoked_at_tx TEXT
         - UNIQUE(agent_id, client, feedback_index)

      5. client_approvals — approved client limits per agent
         - id INTEGER PRIMARY KEY AUTOINCREMENT
         - agent_id INTEGER NOT NULL
         - client TEXT NOT NULL
         - index_limit TEXT NOT NULL  (uint128 as TEXT)
         - set_at_block INTEGER NOT NULL
         - set_at_tx TEXT NOT NULL
         - UNIQUE(agent_id, client)

      6. feedback_responses — agent responses to feedback
         - id INTEGER PRIMARY KEY AUTOINCREMENT
         - agent_id INTEGER NOT NULL
         - client TEXT NOT NULL
         - feedback_index INTEGER NOT NULL
         - responder TEXT NOT NULL
         - response_uri TEXT NOT NULL
         - response_hash TEXT NOT NULL  (hex)
         - created_at_block INTEGER NOT NULL
         - created_at_tx TEXT NOT NULL

      7. validation_requests — validator requests and responses
         - id INTEGER PRIMARY KEY AUTOINCREMENT
         - request_hash TEXT NOT NULL UNIQUE  (hex, 32 bytes)
         - agent_id INTEGER NOT NULL
         - validator TEXT NOT NULL
         - request_uri TEXT NOT NULL
         - has_response INTEGER NOT NULL DEFAULT 0
         - response TEXT             (uint128 as TEXT — response score/value)
         - response_uri TEXT
         - response_hash TEXT        (hex)
         - tag TEXT
         - created_at_block INTEGER NOT NULL
         - created_at_tx TEXT NOT NULL
         - responded_at_block INTEGER
         - responded_at_tx TEXT

      8. sync_state — indexer sync tracking per contract
         - contract_id TEXT PRIMARY KEY
         - last_indexed_block INTEGER NOT NULL DEFAULT 0
         - last_indexed_tx TEXT
         - updated_at TEXT NOT NULL DEFAULT (datetime('now'))

      9. lenses — empty stub for future reputation lens aggregations
         - id INTEGER PRIMARY KEY AUTOINCREMENT
         - name TEXT NOT NULL UNIQUE
         - description TEXT
         - created_at TEXT NOT NULL DEFAULT (datetime('now'))

      Indexes:
      - agents: no extra index (PK)
      - agent_metadata: idx_agent_metadata_agent_id ON agent_metadata(agent_id)
      - approvals: idx_approvals_agent_id ON approvals(agent_id)
      - feedback: idx_feedback_agent_id ON feedback(agent_id)
               idx_feedback_client ON feedback(client)
               idx_feedback_agent_client ON feedback(agent_id, client)
               idx_feedback_is_revoked ON feedback(is_revoked)
      - client_approvals: idx_client_approvals_agent_id ON client_approvals(agent_id)
      - feedback_responses: idx_feedback_responses_agent_id ON feedback_responses(agent_id)
                           idx_feedback_responses_feedback ON feedback_responses(agent_id, client, feedback_index)
      - validation_requests: idx_validation_requests_agent_id ON validation_requests(agent_id)
                            idx_validation_requests_validator ON validation_requests(validator)
    </action>
    <verify>
      npx wrangler d1 migrations apply DB --local --config wrangler.jsonc 2>&1
      Should output "✅ Applied migration" or similar success. No errors.
    </verify>
    <done>migrations/0001_initial.sql exists and applies cleanly to local D1</done>
  </task>

  <task id="2">
    <name>Create TypeScript type definitions</name>
    <files>
      src/types/db.ts,
      src/types/events.ts,
      src/types/chainhook.ts,
      src/types/index.ts
    </files>
    <action>
      Create src/types/ directory with four files:

      db.ts — TypeScript interfaces for each DB row:
      - AgentRow, AgentMetadataRow, ApprovalRow, FeedbackRow, ClientApprovalRow,
        FeedbackResponseRow, ValidationRequestRow, SyncStateRow, LensRow
      - WAD/i128 fields typed as `string` (value, wad_value, value_decimals, index_limit, response)
      - boolean fields as `number` (is_revoked: number, has_response: number, approved: number)

      events.ts — Discriminated union of ERC-8004 event types derived from contract print events.
      Use `notification` field as the discriminant. Each type has a `payload` field.
      Events to define:
      - RegisteredEvent: "identity-registry/Registered"
      - MetadataSetEvent: "identity-registry/MetadataSet"
      - UriUpdatedEvent: "identity-registry/UriUpdated"
      - ApprovalForAllEvent: "identity-registry/ApprovalForAll"
      - TransferEvent: "identity-registry/Transfer"
      - NewFeedbackEvent: "reputation-registry/NewFeedback"
      - FeedbackRevokedEvent: "reputation-registry/FeedbackRevoked"
      - ResponseAppendedEvent: "reputation-registry/ResponseAppended"
      - ClientApprovedEvent: "reputation-registry/ClientApproved"
      - ValidationRequestEvent: "validation-registry/ValidationRequest"
      - ValidationResponseEvent: "validation-registry/ValidationResponse"
      Export `Erc8004Event` as the union of all 11.
      WAD fields (value, wad-value) typed as string; uint128 fields typed as string.
      NOTE: Clarity int128 values in `repr` look like plain integers (e.g. `5`, `4000000000000000000`).

      chainhook.ts — Re-export and narrow types from @hirosystems/chainhooks-client.
      - Re-export ChainhookEvent, StacksBlock, StacksContractLogOperation
      - Define ContractLogValue as the `value` field type of StacksContractLogOperation.metadata
      - Define helper type guard: isContractLogOperation(op: unknown): op is StacksContractLogOperation
      - Define ContractLogReprValue: { hex: string; repr: string }

      index.ts — Barrel re-export of all three modules:
        export * from './db';
        export * from './events';
        export * from './chainhook';
    </action>
    <verify>
      npm run check 2>&1
      Should pass with 0 errors.
    </verify>
    <done>All type files exist, src/types/index.ts barrel exports all, npm run check passes</done>
  </task>

  <task id="3">
    <name>Update src/types.ts to import from src/types/</name>
    <files>src/types.ts, src/index.ts</files>
    <action>
      Update src/types.ts to add a re-export from ./types/ so existing imports (src/index.ts,
      src/rpc.ts, src/middleware/logger.ts) continue to work. Do NOT break any existing imports.

      Add at the bottom of src/types.ts:
        // Re-export domain types from the types/ subdirectory
        export * from './types/index';

      This keeps Env, Logger, LogsRPC, AppVariables in src/types.ts while also making
      db/event/chainhook types available via the same import path.
    </action>
    <verify>
      npm run check 2>&1
      Should still pass with 0 errors. Confirm no duplicate exports.
    </verify>
    <done>src/types.ts re-exports from src/types/index, npm run check still passes</done>
  </task>
</plan>
