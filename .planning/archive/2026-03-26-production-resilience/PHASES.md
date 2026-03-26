# Phases

## Phase 1: Add blocks_seen table and query helpers — `completed`

**Goal:** Create the `blocks_seen` D1 migration, add the `BlockSeenRow` type, add upsert/query functions, and update test helpers with the new DDL.

**Dependencies:** None (foundation for all other phases)

**Files to create:**
- `migrations/0003_blocks_seen.sql`

**Files to modify:**
- `src/types/db.ts` — add `BlockSeenRow` interface
- `src/utils/query.ts` — add `upsertBlockSeen`, `markBlockNonCanonical`, `queryRecentBlocks`
- `src/__tests__/helpers.ts` — add `blocks_seen` DDL to MIGRATION_DDL and `clearData`

**Verify:** `npm run check` passes, `npm test` passes, migration SQL is syntactically valid.

---

## Phase 2: Record blocks_seen in webhook and add source health KV helpers — `completed`

**Goal:** Create `src/utils/source-health.ts` with KV read/write helpers for source health tracking. Integrate `blocks_seen` recording into the webhook handler (apply blocks + rollback marking). Update chainhook source health on each webhook delivery.

**Dependencies:** Phase 1 (blocks_seen table and query helpers must exist)

**Files to create:**
- `src/utils/source-health.ts`

**Files to modify:**
- `src/webhook.ts` — call `upsertBlockSeen` per apply block, `markBlockNonCanonical` per rollback block, update chainhook source health via KV after processing
- `src/types.ts` — add `SourceHealthEntry` type if needed for KV shape

**Verify:** `npm run check` passes, `npm test` passes (existing webhook tests still green), `npm run deploy:dry-run` builds.

---

## Phase 3: Adaptive polling fallback in scheduled handler — `completed`

**Goal:** Enhance `src/scheduled.ts` to read/write source health from KV. When chainhook source is stale (no update in 5 minutes), lower the backfill gap threshold from 10 to 1 so the polling cron catches up faster. Update polling source health after each successful cron run.

**Dependencies:** Phase 2 (source health KV helpers must exist)

**Files to modify:**
- `src/scheduled.ts` — import source health helpers, read chainhook freshness, conditionally lower `GAP_BACKFILL_THRESHOLD`, write polling source health after backfill

**Verify:** `npm run check` passes, `npm test` passes, `npm run deploy:dry-run` builds.

---

## Phase 4: Enhanced status endpoint with source health and recent blocks — `completed`

**Goal:** Expand `GET /api/v1/status` to return source health entries from KV, recent blocks from `blocks_seen`, and gap information. Add integration tests for the new response shape.

**Dependencies:** Phase 1 (queryRecentBlocks), Phase 2 (source health KV), Phase 3 (polling writes source health)

**Files to modify:**
- `src/routes/status.ts` — add source health + recent blocks + gap fields to status response
- `src/__tests__/api.test.ts` — add test for enhanced status response shape

**Verify:** `npm run check` passes, `npm test` passes (including new status test), `npm run deploy:dry-run` builds.
