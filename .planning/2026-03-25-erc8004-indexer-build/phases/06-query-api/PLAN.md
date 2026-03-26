<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Implement all REST endpoints under /api/v1/ for agents, feedback, validations, and status queries with standard pagination, filtering, and sorting. Extend IndexerRPC with query methods. Add integration tests.</goal>
  <context>
    Codebase uses Hono v4 on Cloudflare Workers with D1 (SQLite) for storage.
    The app is in src/index.ts; the webhook handler is the only existing route.
    DB schema: agents, agent_metadata, approvals, feedback, client_approvals,
    feedback_responses, validation_requests, sync_state, lenses.
    All uint128/int128 values stored as TEXT. Boolean fields use 0/1 INTEGER.
    Types are in src/types/db.ts. Env is in src/types.ts.
    Tests use @cloudflare/vitest-pool-workers with SELF binding for HTTP requests,
    and env.DB for direct D1 access. Setup is done via setupDb() in src/__tests__/helpers.ts.
    No existing route modules — the route files need to be created from scratch.
    Pagination defaults: limit=50, max=200. Response envelope: { data, pagination }.
    Single-item endpoints return the object directly without envelope.
  </context>

  <task id="1">
    <name>Pagination utilities and query builders</name>
    <files>
      src/utils/pagination.ts,
      src/utils/query.ts
    </files>
    <action>
      Create src/utils/pagination.ts with:
      - parsePagination(searchParams): { limit: number, offset: number }
        Reads "limit" and "offset" query params. Default limit=50, max=200, min=1.
        Default offset=0, min=0.
      - paginatedResponse(data, total, limit, offset): standard envelope object
        Returns { data, pagination: { limit, offset, total } }

      Create src/utils/query.ts with D1 query builder helpers:
      - queryAgents(db, { limit, offset }): Promise<{ rows: AgentRow[], total: number }>
        SELECT from agents with COUNT(*) for total.
      - queryAgentById(db, agentId: number): Promise<AgentRow | null>
        SELECT single agent by agent_id.
      - queryAgentMetadata(db, agentId: number): Promise<AgentMetadataRow[]>
        SELECT all metadata rows for agent.
      - queryFeedbackSummary(db, agentId: number, filters?: { client?, tag1?, tag2? }):
        Promise<{ total_count: number, active_count: number, revoked_count: number, wad_sum: string }>
        Aggregation query: COUNT(*), SUM of active, SUM of revoked,
        sum of wad_value for active (non-revoked) entries. wad_sum computed as string sum in JS.
        Optional filters on client, tag1, tag2.
      - queryFeedback(db, agentId: number, { limit, offset, client?, tag1?, tag2? }):
        Promise<{ rows: FeedbackRow[], total: number }>
        SELECT from feedback filtered by agent_id and optional client/tag filters.
      - queryFeedbackBySeq(db, agentId: number, client: string, feedbackIndex: number):
        Promise<FeedbackRow | null>
        SELECT single feedback row by agent_id+client+feedback_index.
      - queryClients(db, agentId: number): Promise<ClientApprovalRow[]>
        SELECT all client_approvals for an agent.
      - queryFeedbackResponses(db, agentId: number, client: string, feedbackIndex: number):
        Promise<FeedbackResponseRow[]>
        SELECT all responses for a specific feedback entry.
      - queryRecentFeedback(db, { limit, offset }): Promise<{ rows: FeedbackRow[], total: number }>
        SELECT from feedback ORDER BY created_at_block DESC with pagination.
      - queryValidationSummary(db, agentId: number):
        Promise<{ total: number, pending: number, responded: number }>
        Counts for all/pending/responded validations.
      - queryValidations(db, agentId: number, { limit, offset, has_response? }):
        Promise<{ rows: ValidationRequestRow[], total: number }>
        SELECT from validation_requests by agent_id with optional has_response filter.
      - queryValidationsByValidator(db, validator: string, { limit, offset }):
        Promise<{ rows: ValidationRequestRow[], total: number }>
        SELECT from validation_requests by validator principal.
      - queryValidationByHash(db, requestHash: string):
        Promise<ValidationRequestRow | null>
        SELECT single validation by request_hash.
      - queryStats(db): Promise<{ agents: number, feedback: number, validations: number }>
        COUNT(*) on agents, feedback, validation_requests tables.
      - querySyncState(db): Promise<SyncStateRow[]>
        SELECT all rows from sync_state.

      Import types from ../types (AgentRow, AgentMetadataRow, etc).
      All queries should use parameterized D1 prepare().bind() calls.
    </action>
    <verify>
      npx tsc --noEmit (TypeScript check passes)
    </verify>
    <done>
      src/utils/pagination.ts and src/utils/query.ts exist with all listed functions,
      TypeScript types are correct, no TODO stubs.
    </done>
  </task>

  <task id="2">
    <name>Route modules and app wiring</name>
    <files>
      src/routes/agents.ts,
      src/routes/feedback.ts,
      src/routes/validations.ts,
      src/routes/status.ts,
      src/index.ts,
      src/rpc.ts
    </files>
    <action>
      Create src/routes/agents.ts — Hono router with:
        GET /agents — list all agents with pagination
        GET /agents/:id — get agent by ID (404 if not found)
        GET /agents/:id/metadata — get all metadata for agent (returns array)

      Create src/routes/feedback.ts — Hono router with:
        GET /agents/:id/summary — feedback summary with optional ?client=, ?tag1=, ?tag2= filters
        GET /agents/:id/feedback — list feedback with pagination and optional filters
        GET /agents/:id/feedback/:seq — get single feedback by seq (client:index format "ADDR/0")
          Route param :seq is the feedback_index (number), but route is GET /agents/:id/feedback/:seq
          where :seq is a number. To get by client+index use separate endpoint.
          Actually implement as: GET /agents/:id/feedback/:index where :index is feedback_index
          Return the feedback matching agent_id + feedback_index (may return multiple if different clients)
          Better: follow spec: GET /agents/:id/feedback/:seq where seq is just feedback_index integer
          Return array of feedback entries for that agent at that index.
        GET /agents/:id/clients — list approved clients for agent
        GET /agents/:id/feedback/:client/:index/responses — responses for a specific feedback
          :client is URL-encoded Stacks principal, :index is feedback_index integer
        GET /feedback/recent — recent feedback across all agents with pagination

      Create src/routes/validations.ts — Hono router with:
        GET /agents/:id/validations/summary — validation counts summary
        GET /agents/:id/validations — list validations with pagination and optional ?has_response= filter
        GET /validators/:addr/requests — validations assigned to a validator with pagination
        GET /validations/:hash — get single validation by request_hash (404 if not found)

      Create src/routes/status.ts — Hono router with:
        GET /status — indexer health: { status: "ok", version, timestamp, sync_state: [...] }
        GET /stats — global counts: { agents, feedback, validations }

      Each route file exports a Hono instance typed with { Bindings: Env; Variables: AppVariables }.
      Routes use parsePagination() for limit/offset parsing.
      Routes use query helpers from src/utils/query.ts.
      Single-item 404s return c.json({ error: "Not Found" }, 404).

      Update src/index.ts to mount all route modules under /api/v1:
        import { agentsRoute } from "./routes/agents";
        import { feedbackRoute } from "./routes/feedback";
        import { validationsRoute } from "./routes/validations";
        import { statusRoute } from "./routes/status";
        app.route("/api/v1", agentsRoute);
        app.route("/api/v1", feedbackRoute);
        app.route("/api/v1", validationsRoute);
        app.route("/api/v1", statusRoute);

      Update src/rpc.ts — add methods to IndexerRPC class:
        getAgent(agentId: number): returns AgentRow | null
        getSummary(agentId: number, filters?: { client?, tag1?, tag2? }): returns summary object
        getFeedback(agentId: number, params: { limit?, offset?, client?, tag1?, tag2? }):
          returns paginated envelope { data, pagination }
        getValidationSummary(agentId: number): returns validation summary object
        getStatus(): extended to include sync_state and stats
        getStats(): returns { agents, feedback, validations }
      Import query helpers from ./utils/query.
    </action>
    <verify>
      npx tsc --noEmit (TypeScript check passes)
    </verify>
    <done>
      All 4 route files exist and export Hono routers.
      src/index.ts mounts them under /api/v1.
      src/rpc.ts has 6+ query methods.
      TypeScript passes with no errors.
    </done>
  </task>

  <task id="3">
    <name>Integration tests for query API</name>
    <files>
      src/__tests__/api.test.ts
    </files>
    <action>
      Create src/__tests__/api.test.ts with integration tests:

      Test setup: call setupDb(), put webhook_secret in KV, then POST each fixture
      (identity + reputation + validation) to seed data. Then make GET requests
      to the API endpoints and verify response shapes and data.

      Test groups:
      1. "GET /api/v1/status" — returns { status: "ok", version, timestamp }
      2. "GET /api/v1/stats" — returns { agents: 1, feedback: 1, validations: 1 }
         (after seeding all three fixtures)
      3. "GET /api/v1/agents" — returns envelope with data array, at least 1 agent
      4. "GET /api/v1/agents/1" — returns agent object with agent_id=1
      5. "GET /api/v1/agents/1/metadata" — returns array with at least 1 metadata entry
      6. "GET /api/v1/agents/999" — returns 404
      7. "GET /api/v1/agents/1/summary" — returns summary with total_count, active_count, etc.
         Note: reputation fixture has 1 feedback (revoked), so active_count=0 after revoke.
      8. "GET /api/v1/agents/1/feedback" — returns envelope with data array
      9. "GET /api/v1/agents/1/clients" — returns array with at least 1 client approval
      10. "GET /api/v1/agents/1/validations/summary" — returns { total, pending, responded }
      11. "GET /api/v1/agents/1/validations" — returns envelope with data array
      12. "GET /api/v1/validations/1234567890123456789012345678901234567890123456789012345678901234"
          — returns the validation row
      13. "GET /api/v1/validators/SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE/requests"
          — returns envelope with at least 1 validation
      14. "GET /api/v1/feedback/recent" — returns envelope with data array
      15. Pagination test: GET /api/v1/agents?limit=1&offset=0 — pagination.limit=1

      Use SELF.fetch() for all HTTP requests.
      Parse responses with res.json<ResponseType>().
      Use expect() assertions to verify status codes and response shapes.
    </action>
    <verify>
      npm test passes with all api.test.ts tests passing.
    </verify>
    <done>
      src/__tests__/api.test.ts exists with 15+ test cases,
      all pass when npm test is run.
    </done>
  </task>
</plan>
