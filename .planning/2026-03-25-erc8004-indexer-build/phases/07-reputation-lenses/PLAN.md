<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Implement the reputation lens system: type definitions, execution pipeline, default values, the reference "aibtc" lens, API routes, seed migration, RPC methods, and integration tests.</goal>

  <context>
    The lenses table already exists in migrations/0001_initial.sql with columns: id, name, description, created_at.
    The lenses table does NOT yet have a config column — the seed migration must ALTER TABLE to add it.

    Existing patterns to follow:
    - Routes use Hono with Env + AppVariables generics (see src/routes/agents.ts)
    - Paginated list responses use paginatedResponse() from src/utils/pagination.ts
    - D1 queries use parameterized prepare().bind() calls (see src/utils/query.ts)
    - WAD values (int128) are stored as TEXT in SQLite; BigInt arithmetic in JS layer
    - Tests use cloudflare:test SELF.fetch() + helpers.ts setupDb()/clearData() pattern
    - The lenses route must be registered in src/index.ts like the other routes

    Key design decisions:
    - Lens config stored as JSON TEXT in lenses.config column
    - Block-based rate limit windows (144 blocks per day)
    - Pipeline: trust filter (SQL) -> bounds filter (SQL) -> rate filter (SQL) -> fetch -> decay (JS) -> weight (JS) -> aggregate
    - Transparency metadata: excluded counts per dimension, flags detected
    - LensRow in src/types/db.ts needs a config field added
    - helpers.ts MIGRATION_DDL must be updated to include the config column so tests work
  </context>

  <task id="1">
    <name>Lens types, defaults, aibtc config, and seed migration</name>
    <files>
      src/lenses/types.ts (create),
      src/lenses/defaults.ts (create),
      src/lenses/aibtc.ts (create),
      src/types/db.ts (update LensRow),
      migrations/0002_lenses_seed.sql (create)
    </files>
    <action>
      1. Create src/lenses/types.ts with:
         - TrustDimension: { approved_clients_only: boolean; min_feedback_count_per_reviewer: number }
         - BoundsDimension: { min_wad_value: string | null; max_wad_value: string | null }
         - RateDimension: { max_per_reviewer_per_window: number | null; window_blocks: number }
         - DecayDimension: { enabled: boolean; half_life_blocks: number }
         - WeightDimension: { enabled: boolean; weight_by_reviewer_score: boolean }
         - LensConfig: { trust: TrustDimension; bounds: BoundsDimension; rate: RateDimension; decay: DecayDimension; weight: WeightDimension }

      2. Create src/lenses/defaults.ts with:
         - DEFAULT_TRUST: TrustDimension = { approved_clients_only: false, min_feedback_count_per_reviewer: 0 }
         - DEFAULT_BOUNDS: BoundsDimension = { min_wad_value: null, max_wad_value: null }
         - DEFAULT_RATE: RateDimension = { max_per_reviewer_per_window: null, window_blocks: 144 }
         - DEFAULT_DECAY: DecayDimension = { enabled: false, half_life_blocks: 1440 }
         - DEFAULT_WEIGHT: WeightDimension = { enabled: false, weight_by_reviewer_score: false }
         - DEFAULT_LENS_CONFIG: LensConfig combining all defaults
         - Export mergeLensConfig(partial: Partial<LensConfig>): LensConfig that merges each dimension with its default

      3. Create src/lenses/aibtc.ts with the "aibtc" reference lens config:
         - trust: { approved_clients_only: true, min_feedback_count_per_reviewer: 1 }
         - bounds: { min_wad_value: "-100000000000000000000", max_wad_value: "100000000000000000000" } (±100 WAD)
         - rate: { max_per_reviewer_per_window: 10, window_blocks: 144 }
         - decay: { enabled: true, half_life_blocks: 4320 } (~30 days at 10min blocks)
         - weight: { enabled: false, weight_by_reviewer_score: false }
         Export: AIBTC_LENS_CONFIG: LensConfig and AIBTC_LENS_META: { name: "aibtc", description: "..." }

      4. Update src/types/db.ts: add config: string field to LensRow (JSON-encoded LensConfig)

      5. Create migrations/0002_lenses_seed.sql:
         ALTER TABLE lenses ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
         INSERT OR IGNORE INTO lenses (name, description, config) VALUES ('aibtc', '...', '[json of aibtc config]');
    </action>
    <verify>
      npx tsc --noEmit (should have no type errors in the new files)
    </verify>
    <done>
      All type files compile cleanly. The aibtc.ts exports a valid LensConfig object.
      Migration SQL is well-formed. LensRow has config field.
    </done>
  </task>

  <task id="2">
    <name>Lens pipeline and query utilities</name>
    <files>
      src/lenses/pipeline.ts (create),
      src/utils/query.ts (update — add lens query functions)
    </files>
    <action>
      1. Add lens query helpers to src/utils/query.ts:
         - queryLenses(db): Promise&lt;LensRow[]&gt; — SELECT * FROM lenses ORDER BY name ASC
         - queryLensByName(db, name): Promise&lt;LensRow | null&gt;
         - createLens(db, name, description, config): Promise&lt;void&gt; — INSERT INTO lenses
         - updateLens(db, name, config): Promise&lt;void&gt; — UPDATE lenses SET config=? WHERE name=?

      2. Create src/lenses/pipeline.ts with:

         Interface FeedbackWithBlock: FeedbackRow (from db) extended with numeric wad_value_bigint for internal use

         Interface LensPipelineResult:
           agent_id: number
           lens_name: string
           score: string  (WAD string, weighted average)
           included_count: number
           excluded_count: number
           exclusions: Array&lt;{ reason: string; count: number }&gt;
           flags: string[]  (e.g., ["bulk_revocation", "rate_spike"])
           config: LensConfig

         Function runLensPipeline(db: D1Database, agentId: number, lensName: string, config: LensConfig, currentBlock: number): Promise&lt;LensPipelineResult&gt;

         Pipeline steps:
         a) Fetch all feedback for agent (non-revoked only, unless trust allows otherwise)
            SELECT * FROM feedback WHERE agent_id = ? AND is_revoked = 0
         b) Trust filter: if approved_clients_only, only include clients in client_approvals table
            If min_feedback_count_per_reviewer > 0, exclude clients with fewer entries
            Track exclusions with reason "trust"
         c) Bounds filter: exclude entries where wad_value as BigInt is outside [min_wad_value, max_wad_value]
            Track exclusions with reason "bounds"
         d) Rate filter: if max_per_reviewer_per_window set, within each window of window_blocks blocks,
            keep only the first max_per_reviewer_per_window entries per client (by created_at_block ASC)
            Track exclusions with reason "rate"
         e) Fetch remaining entries (already in memory from step a, filtered in JS)
         f) Decay weighting: if enabled, weight each entry by exp(-ln(2) * age_blocks / half_life_blocks)
            age_blocks = currentBlock - created_at_block (floor at 0)
            Use floating point for intermediate calculations
         g) Weight dimension: reserved for future implementation (pass through with weight=1.0 if disabled)
         h) Aggregate: weighted sum / total weight = score in WAD
            If no entries: score = "0"
         i) Flag detection:
            "bulk_revocation": if more than 20% of all feedback (including revoked) was revoked in the last 144 blocks
            "rate_spike": if any single client submitted more entries than max_per_reviewer_per_window in one window

         Return LensPipelineResult with all fields.
    </action>
    <verify>
      npx tsc --noEmit (no type errors)
    </verify>
    <done>
      Pipeline compiles cleanly. All 5 dimensions handled. Transparency metadata populated. Flags detected.
    </done>
  </task>

  <task id="3">
    <name>Lens API routes, RPC methods, wiring, and tests</name>
    <files>
      src/routes/lenses.ts (create),
      src/rpc.ts (update — add getLensSummary, getLensScore, listLenses),
      src/index.ts (update — register lenses route),
      src/__tests__/helpers.ts (update — add config column to MIGRATION_DDL and lenses seed),
      src/__tests__/lenses.test.ts (create)
    </files>
    <action>
      1. Create src/routes/lenses.ts with:
         GET /lenses — list all lenses (returns array with name, description, config parsed from JSON)
         GET /lenses/:lens — get a single lens config by name (404 if not found)
         GET /lenses/:lens/agents/:id/summary — run pipeline for agent through lens, return LensPipelineResult
           Query param: block (optional, defaults to a sentinel 999999999 to mean "latest")
         GET /lenses/:lens/agents/:id/feedback — list feedback that would pass through lens (without scoring)
           Return paginated list with transparency metadata
         GET /lenses/:lens/agents/:id/score — return just the score field from pipeline result
         POST /lenses (admin) — create a new lens; require Authorization: Bearer header matching env.ADMIN_TOKEN
           Body: { name, description, config }
         PUT /lenses/:lens (admin) — update lens config; require ADMIN_TOKEN

         For admin auth: check Authorization header; if env.ADMIN_TOKEN is not set or doesn't match, return 401.
         The Env interface doesn't have ADMIN_TOKEN yet — add it as optional: ADMIN_TOKEN?: string.

         Use current block as 999999999 (no real block available in worker without chain call) unless query param provided.

      2. Update src/rpc.ts:
         - Import queryLenses, queryLensByName from utils/query
         - Import runLensPipeline, LensPipelineResult from lenses/pipeline
         - Add listLenses(): Promise&lt;LensRow[]&gt;
         - Add getLensByName(name: string): Promise&lt;LensRow | null&gt;
         - Add getLensScore(agentId: number, lensName: string, currentBlock?: number): Promise&lt;{ agent_id: number; lens_name: string; score: string }&gt;
         - Add getLensSummary(agentId: number, lensName: string, currentBlock?: number): Promise&lt;LensPipelineResult&gt;

      3. Update src/index.ts: import lensesRoute from ./routes/lenses and register with app.route("/api/v1", lensesRoute)

      4. Update src/__tests__/helpers.ts:
         - Add config column to lenses table in MIGRATION_DDL: config TEXT NOT NULL DEFAULT '{}'
         - Add seed insert for "aibtc" lens with its JSON config

      5. Create src/__tests__/lenses.test.ts:
         Test: GET /api/v1/lenses returns array with at least the "aibtc" lens
         Test: GET /api/v1/lenses/aibtc returns lens config object with all 5 dimensions
         Test: GET /api/v1/lenses/nonexistent returns 404
         Test: GET /api/v1/lenses/aibtc/agents/1/score returns { score: "0" } for agent with no feedback
         Test: GET /api/v1/lenses/aibtc/agents/1/summary returns result with included_count=0, excluded_count=0
         Test: Same raw feedback through "aibtc" (approved_clients_only=true) vs a permissive lens produces different scores
           - Insert an "open" lens with trust: { approved_clients_only: false, min_feedback_count_per_reviewer: 0 }
           - Seed feedback from a non-approved client
           - aibtc score should be "0" (client not approved), open lens score should be non-zero
         Test: POST /lenses without admin token returns 401
         Test: POST /lenses with admin token creates a new lens
    </action>
    <verify>
      npm run check (tsc --noEmit)
      npm test (all tests pass, including new lenses.test.ts)
      Verify lens routes are accessible: GET /api/v1/lenses in test
    </verify>
    <done>
      All lens API endpoints return correct shapes. Tests pass. RPC methods added.
      src/index.ts registers lensesRoute. ADMIN_TOKEN optional in Env.
    </done>
  </task>
</plan>
