# ERC-8004 Indexer — Implementation Plan

## Overview

A Cloudflare Worker that indexes ERC-8004 contract events from Stacks and exposes them through two tiers:

1. **Spec Index** — raw events, unfiltered aggregation, spec-equivalent queries
2. **Reputation Lenses** — modular rule sets that layer opinionated scoring on top of raw data

The spec index is the canonical source of truth. Lenses are named configurations (e.g., `aibtc`, `partner-x`) that apply trust filtering, value normalization, rate-limit detection, and time decay without altering the underlying data. Any consumer — frontend, agent, or service — picks a lens or queries raw.

```
Chainhooks 2.0 (hosted, Hiro API key)
    │ webhook POST (apply[] + rollback[])
    ▼
┌──────────────────────────────────────────────┐
│  erc8004-indexer                             │
│                                              │
│  POST /webhook       ← chainhook events      │
│  GET  /api/v1/*      ← spec-equivalent API   │
│  GET  /api/v1/lenses/* ← lens-filtered API   │
│                                              │
│  Bindings:                                   │
│    D1         → event storage + lens configs  │
│    KV         → indexer state + chainhook IDs │
│    LOGS       → worker-logs service binding   │
│    CACHE      → aibtcdev-cache (optional)     │
│                                              │
│  Exports:                                    │
│    IndexerRPC → WorkerEntrypoint for workers  │
└──────────────────────────────────────────────┘
```

---

## Phase 1: Foundation

Webhook receiver, D1 schema, event handlers for all 12 SIP-019 events. No query API yet — just ingest and store.

### 1.1 Project scaffold

```
erc-8004-indexer/
  src/
    index.ts              # Hono app + route registration
    rpc.ts                # WorkerEntrypoint for service bindings
    webhook.ts            # Chainhook payload parser + event router
    handlers/
      identity.ts         # Registered, MetadataSet, UriUpdated, ApprovalForAll, Transfer
      reputation.ts       # ClientApproved, NewFeedback, FeedbackRevoked, ResponseAppended
      validation.ts       # ValidationRequest, ValidationResponse
    types.ts              # Chainhook payload types, event types, env bindings
  migrations/
    0001_initial.sql      # D1 schema
  wrangler.jsonc          # Worker config with D1, KV, service bindings
  package.json
  tsconfig.json
  vitest.config.ts
```

- **Framework**: Hono (matches worker-logs pattern)
- **Runtime**: `nodejs_compat_v2` compatibility flag
- **Test**: Vitest with miniflare for D1/KV mocking

### 1.2 D1 schema

Core tables store raw events. No interpretation, no filtering — just the on-chain record.

```sql
-- Agents (identity registry)
CREATE TABLE agents (
  agent_id     INTEGER PRIMARY KEY,
  owner        TEXT NOT NULL,
  token_uri    TEXT,
  block_height INTEGER NOT NULL,
  tx_hash      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agents_owner ON agents(owner);

-- Agent metadata (key-value pairs)
CREATE TABLE agent_metadata (
  agent_id     INTEGER NOT NULL,
  key          TEXT NOT NULL,
  value        BLOB,
  block_height INTEGER NOT NULL,
  tx_hash      TEXT NOT NULL,
  PRIMARY KEY (agent_id, key),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

-- Operator approvals
CREATE TABLE approvals (
  agent_id     INTEGER NOT NULL,
  operator     TEXT NOT NULL,
  approved     INTEGER NOT NULL DEFAULT 1,
  block_height INTEGER NOT NULL,
  tx_hash      TEXT NOT NULL,
  PRIMARY KEY (agent_id, operator),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

-- Feedback (reputation registry)
CREATE TABLE feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        INTEGER NOT NULL,
  client          TEXT NOT NULL,
  client_index    INTEGER NOT NULL,
  global_seq      INTEGER NOT NULL,
  value           INTEGER NOT NULL,         -- raw int value
  value_decimals  INTEGER NOT NULL,
  wad_value       INTEGER NOT NULL,         -- normalized to 18 decimals
  tag1            TEXT,
  tag2            TEXT,
  endpoint        TEXT,
  feedback_uri    TEXT,
  feedback_hash   BLOB,
  is_revoked      INTEGER NOT NULL DEFAULT 0,
  block_height    INTEGER NOT NULL,
  tx_hash         TEXT NOT NULL,
  UNIQUE (agent_id, client, client_index)
);
CREATE INDEX idx_feedback_agent ON feedback(agent_id, is_revoked);
CREATE INDEX idx_feedback_client ON feedback(client, agent_id);
CREATE INDEX idx_feedback_global_seq ON feedback(global_seq);
CREATE INDEX idx_feedback_tags ON feedback(tag1, tag2);
CREATE INDEX idx_feedback_block ON feedback(block_height);

-- Client approvals (reputation registry)
CREATE TABLE client_approvals (
  agent_id     INTEGER NOT NULL,
  client       TEXT NOT NULL,
  index_limit  INTEGER NOT NULL,
  approved_by  TEXT NOT NULL,
  block_height INTEGER NOT NULL,
  tx_hash      TEXT NOT NULL,
  PRIMARY KEY (agent_id, client)
);

-- Feedback responses
CREATE TABLE feedback_responses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        INTEGER NOT NULL,
  client          TEXT NOT NULL,
  client_index    INTEGER NOT NULL,
  responder       TEXT NOT NULL,
  response_uri    TEXT,
  response_hash   BLOB,
  block_height    INTEGER NOT NULL,
  tx_hash         TEXT NOT NULL
);
CREATE INDEX idx_responses_feedback ON feedback_responses(agent_id, client, client_index);

-- Validation requests
CREATE TABLE validation_requests (
  request_hash   BLOB PRIMARY KEY,
  agent_id       INTEGER NOT NULL,
  validator      TEXT NOT NULL,
  request_uri    TEXT,
  has_response   INTEGER NOT NULL DEFAULT 0,
  response       INTEGER,                    -- 0-100
  response_uri   TEXT,
  response_hash  BLOB,
  tag            TEXT,
  block_height   INTEGER NOT NULL,
  tx_hash        TEXT NOT NULL,
  last_update    INTEGER                     -- block height of latest response
);
CREATE INDEX idx_validations_agent ON validation_requests(agent_id);
CREATE INDEX idx_validations_validator ON validation_requests(validator);
CREATE INDEX idx_validations_tag ON validation_requests(tag);

-- Indexer bookkeeping
CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: last_block_height, last_block_hash, chainhook_uuid
```

**Note on integer types**: D1 uses SQLite which stores integers as 64-bit signed. Clarity `int` is 128-bit. WAD values (up to ~1.7e38) exceed i64 range. Store these as TEXT in the actual implementation and cast in queries, or use two columns (high/low). This needs a concrete decision during implementation — TEXT with numeric collation is simplest.

### 1.3 Webhook handler

```
POST /webhook
  Authorization: Bearer <CHAINHOOK_SECRET>

  1. Validate bearer token
  2. Parse ChainhookPayload { event: { apply[], rollback[] } }
  3. For each block in apply[]:
     - For each tx in block.transactions:
       - For each operation where type = "contract_log" and topic = "print":
         - Parse notification string to route to handler
         - Handler inserts/updates D1 rows within a transaction
  4. For each block in rollback[]:
     - DELETE all rows WHERE block_height = rolled_back_height AND tx_hash = rolled_back_tx
  5. Update sync_state with latest block
  6. Log to worker-logs
  7. Return 204
```

Event routing by notification prefix:

| Notification | Handler |
|---|---|
| `identity-registry/*` | `handlers/identity.ts` |
| `reputation-registry/*` | `handlers/reputation.ts` |
| `validation-registry/*` | `handlers/validation.ts` |

### 1.4 Chainhook registration

A one-time setup script (or wrangler command) that registers three `contract_log` filters via the Chainhooks 2.0 SDK:

```typescript
// scripts/register-chainhooks.ts
import { ChainhooksClient, CHAINHOOKS_BASE_URL } from '@hirosystems/chainhooks-client';

const contracts = [
  'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2',
  'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2',
  'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.validation-registry-v2',
];

// Register one chainhook with OR-combined filters for all three contracts
const chainhook = await client.registerChainhook({
  name: 'erc8004-mainnet',
  chain: 'stacks',
  network: 'mainnet',
  filters: {
    events: contracts.map(c => ({ type: 'contract_log', contract_identifier: c })),
  },
  action: { type: 'http_post', url: WORKER_URL + '/webhook' },
  options: { decode_clarity_values: true, enable_on_registration: true },
});

// Store UUID in KV for health checks
```

Testnet uses the same pattern with `ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18` contracts.

### 1.5 Deliverables

- [ ] Worker processes all 12 event types and stores to D1
- [ ] Rollback handling deletes affected rows
- [ ] sync_state tracks last processed block
- [ ] worker-logs integration working
- [ ] Chainhook registration script for mainnet + testnet
- [ ] Tests for each event handler with mocked payloads

---

## Phase 2: Spec-Equivalent Query API

REST endpoints that match the ERC-8004 spec's read functions, without the on-chain limitations. No page-size-14 ceiling, full SQL filtering, standard pagination.

### 2.1 Endpoints

All under `/api/v1/`. Standard pagination via `?limit=50&offset=0` (default limit 50, max 200).

**Identity**

| Method | Path | Spec equivalent | Notes |
|--------|------|-----------------|-------|
| GET | `/agents` | — | List agents, filter by `?owner=` |
| GET | `/agents/:id` | `owner-of` + metadata | Full agent profile: owner, uri, wallet, metadata, approvals |
| GET | `/agents/:id/metadata` | `get-metadata` | All metadata key-value pairs |

**Reputation**

| Method | Path | Spec equivalent | Notes |
|--------|------|-----------------|-------|
| GET | `/agents/:id/summary` | `getSummary` | `?clients=addr1,addr2&tag1=foo&tag2=bar` — the filtered query the spec requires |
| GET | `/agents/:id/feedback` | `readAllFeedback` | `?clients=&tag1=&tag2=&include_revoked=false&limit=&offset=` |
| GET | `/agents/:id/feedback/:seq` | `readFeedback` | Single feedback by global sequence |
| GET | `/agents/:id/clients` | `getClients` | All clients who gave feedback |
| GET | `/agents/:id/feedback/:client/:index/responses` | — | Responses to a specific feedback entry |
| GET | `/feedback/recent` | — | Global feed, most recent first |

**Validation**

| Method | Path | Spec equivalent | Notes |
|--------|------|-----------------|-------|
| GET | `/agents/:id/validations/summary` | `getSummary` | `?validators=addr1,addr2&tag=foo` |
| GET | `/agents/:id/validations` | `getAgentValidations` | `?tag=&has_response=` |
| GET | `/validators/:addr/requests` | `getValidatorRequests` | `?agent_id=&tag=` |
| GET | `/validations/:hash` | `getValidationStatus` | Single validation by request hash |

**Utility**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/status` | Indexer health: last block, chainhook status, event counts |
| GET | `/stats` | Global stats: total agents, total feedback, total validations |

### 2.2 Summary query — the key one

This is the query the spec requires but Clarity can't do efficiently:

```sql
-- GET /agents/:id/summary?clients=SP...,SP...&tag1=reliability
SELECT
  COUNT(*) as count,
  SUM(wad_value) as wad_sum
FROM feedback
WHERE agent_id = ?
  AND is_revoked = 0
  AND (client IN (?, ?) OR ? IS NULL)  -- client filter (optional)
  AND (tag1 = ? OR ? IS NULL)          -- tag1 filter (optional)
  AND (tag2 = ? OR ? IS NULL);         -- tag2 filter (optional)
```

Response:

```json
{
  "agent_id": 0,
  "count": 42,
  "summary_value": "3500000000000000000",
  "summary_value_decimals": 18,
  "filters_applied": {
    "clients": ["SP...", "SP..."],
    "tag1": "reliability",
    "tag2": null
  }
}
```

When called with no filters, this matches the on-chain `get-summary` running totals exactly.

### 2.3 RPC entrypoint

Same functions exposed via `WorkerEntrypoint` for service bindings:

```typescript
export class IndexerRPC extends WorkerEntrypoint<Env> {
  async getAgent(agentId: number): Promise<Agent | null> { ... }
  async getSummary(agentId: number, clients?: string[], tag1?: string, tag2?: string): Promise<Summary> { ... }
  async getFeedback(agentId: number, filters: FeedbackFilters): Promise<PaginatedResult<Feedback>> { ... }
  async getValidationSummary(agentId: number, validators?: string[], tag?: string): Promise<ValidationSummary> { ... }
  async getStatus(): Promise<IndexerStatus> { ... }
}
```

Other workers bind via:
```jsonc
"services": [{ "binding": "INDEXER", "service": "erc8004-indexer", "entrypoint": "IndexerRPC" }]
```

And call `env.INDEXER.getSummary(0, ["SP..."])` directly.

### 2.4 Deliverables

- [ ] All query endpoints implemented and tested
- [ ] RPC entrypoint exports all query functions
- [ ] Pagination, filtering, and sorting work correctly
- [ ] Response format documented (OpenAPI or equivalent)
- [ ] Integration test: ingest events → query results match expected

---

## Phase 3: Reputation Lenses

The modular system that lets aibtc (and any future service) layer opinionated reputation scoring on top of the raw spec index. A lens is a named configuration that transforms raw data at query time — it never alters the stored events.

### 3.1 Concept

```
Raw spec index (Phase 2)          Lens layer (Phase 3)
┌─────────────────────┐    ┌──────────────────────────────┐
│ All feedback stored  │───▶│ Lens: "aibtc"                │
│ No interpretation    │    │  - trust: require identity   │
│ No filtering         │    │  - bounds: 0-5 WAD           │
│                      │    │  - rate: 3/day per client    │
│                      │    │  - decay: 90-day half-life   │
│                      │    │  - weight: reviewer rep      │
│                      │───▶│                              │
│                      │    │ Lens: "partner-x"            │
│                      │    │  - trust: approved only      │
│                      │    │  - bounds: none              │
│                      │    │  - rate: none                │
│                      │    │  - decay: none               │
│                      │    │  - weight: equal             │
└─────────────────────┘    └──────────────────────────────┘
```

A lens defines **rules** across five dimensions:

| Dimension | What it controls | Example (aibtc) |
|-----------|-----------------|-----------------|
| **Trust** | Which reviewers to include | Require ERC-8004 identity, minimum reputation |
| **Bounds** | Valid value range | 0-5 WAD (exclude outliers) |
| **Rate** | Submission frequency limits | Flag >3 entries/day per client per agent |
| **Decay** | Time weighting | 90-day half-life on feedback weight |
| **Weight** | Reviewer importance | Scale by reviewer's own reputation score |

### 3.2 Lens configuration

Stored in D1 as a JSON document per lens:

```sql
CREATE TABLE lenses (
  name        TEXT PRIMARY KEY,
  config      TEXT NOT NULL,          -- JSON lens configuration
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

```json
{
  "name": "aibtc",
  "description": "AIBTC platform reputation lens",
  "rules": {
    "trust": {
      "require_identity": true,
      "min_agent_age_blocks": 144,
      "excluded_clients": []
    },
    "bounds": {
      "min_wad": "0",
      "max_wad": "5000000000000000000",
      "outlier_action": "exclude"
    },
    "rate": {
      "max_per_client_per_agent_per_day": 3,
      "flag_revoke_resubmit": true,
      "flag_bulk_revocation": true,
      "bulk_revocation_threshold": 5
    },
    "decay": {
      "enabled": true,
      "half_life_blocks": 12960,
      "reference": "current_block"
    },
    "weight": {
      "mode": "reputation_weighted",
      "min_reviewer_feedback_count": 1,
      "new_reviewer_weight": 0.5
    }
  }
}
```

A minimal lens that just filters by trusted clients:

```json
{
  "name": "partner-x",
  "description": "Partner X — approved clients only",
  "rules": {
    "trust": {
      "require_identity": false,
      "trusted_clients": ["SP...", "SP..."]
    }
  }
}
```

Omitted dimensions use pass-through defaults (no filtering, no decay, equal weight).

### 3.3 Lens query API

Mirror the spec-equivalent endpoints under `/api/v1/lenses/:lens/`:

| Method | Path | What it does |
|--------|------|-------------|
| GET | `/lenses` | List available lenses |
| GET | `/lenses/:lens` | Get lens configuration |
| GET | `/lenses/:lens/agents/:id/summary` | Filtered + weighted summary |
| GET | `/lenses/:lens/agents/:id/feedback` | Feedback with lens rules applied |
| GET | `/lenses/:lens/agents/:id/score` | Composite score (lens-specific) |

The lens summary response includes transparency about what was applied:

```json
{
  "agent_id": 0,
  "lens": "aibtc",
  "count": 28,
  "excluded_count": 14,
  "summary_value": "3200000000000000000",
  "summary_value_decimals": 18,
  "rules_applied": {
    "trust": { "excluded": 8, "reason": "no_identity" },
    "bounds": { "excluded": 3, "reason": "out_of_range" },
    "rate": { "excluded": 2, "reason": "rate_limited" },
    "decay": { "applied": true, "half_life_blocks": 12960 },
    "weight": { "mode": "reputation_weighted" }
  },
  "flags": [
    { "type": "bulk_revocation", "client": "SP...", "count": 5, "block_range": [180200, 180201] }
  ]
}
```

### 3.4 Lens execution

Lenses execute as SQL query modifiers + post-processing. The pipeline:

```
1. Base query (same as Phase 2)
   ↓
2. Trust filter (WHERE clause: join against agents table, check identity)
   ↓
3. Bounds filter (WHERE clause: wad_value BETWEEN min AND max)
   ↓
4. Rate filter (window function: ROW_NUMBER() OVER (PARTITION BY client, agent_id, date))
   ↓
5. Fetch matching rows
   ↓
6. Decay weighting (application code: weight = 0.5 ^ (age_blocks / half_life))
   ↓
7. Reviewer weighting (application code: weight *= reviewer_score)
   ↓
8. Weighted aggregation → final score
```

Steps 2-4 are SQL. Steps 6-7 are application code on the result set. This keeps the hot path in D1 and only does math on the filtered subset.

### 3.5 RPC entrypoint extension

```typescript
export class IndexerRPC extends WorkerEntrypoint<Env> {
  // Phase 2 (raw)
  async getSummary(agentId: number, clients?: string[], tag1?: string, tag2?: string): Promise<Summary> { ... }

  // Phase 3 (lens)
  async getLensSummary(lens: string, agentId: number): Promise<LensSummary> { ... }
  async getLensScore(lens: string, agentId: number): Promise<LensScore> { ... }
  async listLenses(): Promise<LensConfig[]> { ... }
}
```

### 3.6 Deliverables

- [ ] Lens configuration schema defined and validated
- [ ] `aibtc` lens created as the reference implementation
- [ ] Lens query pipeline: SQL filters + application-layer weighting
- [ ] Transparency metadata in all lens responses (what was excluded, why)
- [ ] Flag detection: bulk revocation, revoke-resubmit, rate spikes
- [ ] Lens CRUD (admin-only: create, update lenses)
- [ ] Tests: same raw data through different lenses produces different scores

---

## Phase 4: Operational Hardening

### 4.1 Alarms and health checks

- **Chainhook health**: cron trigger (every 5 min) checks chainhook status via Chainhooks 2.0 API. If inactive, log alert to worker-logs and attempt re-registration.
- **Gap detection**: compare `sync_state.last_block_height` against latest Stacks block (via aibtcdev-cache or Hiro API). If gap > 10 blocks, use `evaluateChainhook()` to replay missed blocks.
- **D1 integrity**: periodic check that feedback counts match between D1 aggregation and on-chain `get-agent-feedback-count` (via read-only contract call through cache).

### 4.2 Backfill

For initial deployment or recovery:

```typescript
// scripts/backfill.ts
// Use evaluateChainhook() to replay from deployment block to current
// Process blocks sequentially to maintain ordering guarantees
// Store progress in KV so backfill can resume if interrupted
```

The mainnet contracts were deployed recently, so the backfill window is small.

### 4.3 Environments

| Environment | Contracts | Worker | D1 |
|---|---|---|---|
| Staging | `ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.*-v2` | `indexer.aibtc.dev` | `erc8004-indexer-staging` |
| Production | `SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.*-v2` | `indexer.aibtc.com` | `erc8004-indexer-production` |

### 4.4 Logging

All operations log to `worker-logs` via service binding:

```typescript
// Structured log context for every webhook
await env.LOGS.info('erc8004-indexer', 'NewFeedback processed', {
  agentId, client, globalSeq, blockHeight, wadValue
});

// Alerts for anomalies
await env.LOGS.warn('erc8004-indexer', 'Bulk revocation detected', {
  client, agentId, count: 5, blockRange: [180200, 180201]
});
```

### 4.5 Deliverables

- [ ] Cron-based chainhook health check
- [ ] Gap detection and auto-backfill
- [ ] Backfill script for initial deployment
- [ ] Staging + production environments configured
- [ ] Logging covers all event processing and anomalies

---

## Dependencies

| Dependency | Purpose | Required by |
|---|---|---|
| Hiro API key | Chainhooks 2.0 registration | Phase 1 |
| `@hirosystems/chainhooks-client` | SDK for chainhook management | Phase 1 |
| `hono` | HTTP framework | Phase 1 |
| D1 database | Event storage | Phase 1 |
| KV namespace | Indexer state | Phase 1 |
| `worker-logs` service binding | Centralized logging | Phase 1 |
| `aibtcdev-cache` service binding | Stacks API access (optional) | Phase 4 |
| Cloudflare account | Worker deployment | Phase 1 |

## Open Questions

1. **i128 storage in D1**: WAD values can exceed SQLite's i64 range. Options: store as TEXT with numeric sorting, store as two i64 columns (high/low), or accept precision loss for extreme values. TEXT is simplest and lossless — recommend starting there.

2. **Lens management**: Should lenses be admin-only (hardcoded per deployment) or user-creatable (anyone can define a lens)? Start admin-only, open up later if there's demand.

3. **Rate limit windows**: The `rate` dimension needs a time window definition. Block-based (per 144 blocks ≈ 1 day) is chain-native. Calendar-based (per UTC day) is simpler for humans. Recommend block-based for consistency.

4. **Cross-network**: Should one worker index both mainnet and testnet, or separate deployments? Separate is simpler and matches the environment split. Recommend separate.

5. **Historical RPC fallback**: If chainhook misses events or for initial sync, should the worker also support pulling historical data via Stacks API RPC calls? This would use the aibtcdev-cache service binding. Worth having as a fallback but not a primary path.
