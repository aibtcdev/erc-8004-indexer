/**
 * Lens execution pipeline for ERC-8004 reputation scoring.
 *
 * The pipeline processes raw feedback through 5 configurable dimensions:
 *   1. Trust filter:  Which reviewers' feedback to include.
 *   2. Bounds filter: Exclude entries outside acceptable WAD value range.
 *   3. Rate filter:   Cap entries per reviewer per block window.
 *   4. Decay weight:  Downweight older entries via exponential decay.
 *   5. Reviewer weight: (reserved) Multiply by reviewer's own score.
 *
 * Produces a LensPipelineResult with the final score and full transparency
 * metadata (exclusion counts, reasons, flags detected).
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { FeedbackRow, ClientApprovalRow } from "../types/db";
import type { LensConfig } from "./types";

// ============================================================
// Result types
// ============================================================

/** One exclusion reason and how many entries it excluded. */
export interface ExclusionRecord {
  reason: "trust" | "bounds" | "rate";
  count: number;
}

/** Full output of the lens pipeline for one agent. */
export interface LensPipelineResult {
  agent_id: number;
  lens_name: string;
  /** WAD-scale score as decimal string (weighted average). "0" if no entries. */
  score: string;
  /** Number of feedback entries that contributed to the score. */
  included_count: number;
  /** Total entries excluded across all dimensions. */
  excluded_count: number;
  /** Per-dimension exclusion breakdown. */
  exclusions: ExclusionRecord[];
  /** Anomaly flags detected during pipeline execution. */
  flags: string[];
  /** The lens configuration used. */
  config: LensConfig;
}

// ============================================================
// Internal helpers
// ============================================================

/** Parse a TEXT wad_value to BigInt safely, returning 0n on error. */
function parseBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return BigInt(0);
  }
}

// ============================================================
// Pipeline entry point
// ============================================================

/**
 * Run the lens pipeline for a single agent.
 *
 * @param db           D1 database binding.
 * @param agentId      Agent to score.
 * @param lensName     Name of the lens (for transparency metadata).
 * @param config       Fully-merged LensConfig to apply.
 * @param currentBlock Current Stacks block height (used for decay and rate windows).
 */
export async function runLensPipeline(
  db: D1Database,
  agentId: number,
  lensName: string,
  config: LensConfig,
  currentBlock: number
): Promise<LensPipelineResult> {
  const exclusions: ExclusionRecord[] = [];
  const flags: string[] = [];

  // ── Fetch all feedback for the agent ───────────────────────────────────
  // We include revoked entries to detect bulk-revocation flags later, but
  // only non-revoked entries proceed through the scoring pipeline.
  const allFeedbackResult = await db
    .prepare(
      "SELECT * FROM feedback WHERE agent_id = ? ORDER BY created_at_block ASC, feedback_index ASC"
    )
    .bind(agentId)
    .all<FeedbackRow>();

  const allFeedback = allFeedbackResult.results ?? [];
  const revokedEntries = allFeedback.filter((f) => f.is_revoked === 1);
  let activeFeedback = allFeedback.filter((f) => f.is_revoked === 0);

  // ── Flag: bulk revocation ───────────────────────────────────────────────
  // Triggered if >20% of all entries were revoked in the last 144 blocks.
  const recentRevocations = revokedEntries.filter(
    (f) =>
      f.revoked_at_block !== null &&
      f.revoked_at_block >= currentBlock - 144
  );
  if (
    allFeedback.length > 0 &&
    recentRevocations.length / allFeedback.length > 0.2
  ) {
    flags.push("bulk_revocation");
  }

  // ── Step 1: Trust filter ────────────────────────────────────────────────
  const { trust } = config;
  let trustExcluded = 0;

  if (trust.approved_clients_only) {
    // Fetch approved clients for this agent
    const approvedResult = await db
      .prepare(
        "SELECT client FROM client_approvals WHERE agent_id = ?"
      )
      .bind(agentId)
      .all<Pick<ClientApprovalRow, "client">>();
    const approvedSet = new Set(
      (approvedResult.results ?? []).map((r) => r.client)
    );

    const filtered = activeFeedback.filter((f) => approvedSet.has(f.client));
    trustExcluded += activeFeedback.length - filtered.length;
    activeFeedback = filtered;
  }

  if (trust.min_feedback_count_per_reviewer > 0) {
    // Count entries per client
    const countsByClient = new Map<string, number>();
    for (const f of activeFeedback) {
      countsByClient.set(f.client, (countsByClient.get(f.client) ?? 0) + 1);
    }
    const filtered = activeFeedback.filter(
      (f) =>
        (countsByClient.get(f.client) ?? 0) >=
        trust.min_feedback_count_per_reviewer
    );
    trustExcluded += activeFeedback.length - filtered.length;
    activeFeedback = filtered;
  }

  if (trustExcluded > 0) {
    exclusions.push({ reason: "trust", count: trustExcluded });
  }

  // ── Step 2: Bounds filter ───────────────────────────────────────────────
  const { bounds } = config;
  let boundsExcluded = 0;

  if (bounds.min_wad_value !== null || bounds.max_wad_value !== null) {
    const minBound =
      bounds.min_wad_value !== null ? parseBigInt(bounds.min_wad_value) : null;
    const maxBound =
      bounds.max_wad_value !== null ? parseBigInt(bounds.max_wad_value) : null;

    const filtered = activeFeedback.filter((f) => {
      const v = parseBigInt(f.wad_value);
      if (minBound !== null && v < minBound) return false;
      if (maxBound !== null && v > maxBound) return false;
      return true;
    });
    boundsExcluded = activeFeedback.length - filtered.length;
    activeFeedback = filtered;
  }

  if (boundsExcluded > 0) {
    exclusions.push({ reason: "bounds", count: boundsExcluded });
  }

  // ── Step 3: Rate filter ─────────────────────────────────────────────────
  const { rate } = config;
  let rateExcluded = 0;

  if (rate.max_per_reviewer_per_window !== null) {
    const maxPerWindow = rate.max_per_reviewer_per_window;
    const windowBlocks = rate.window_blocks;

    // Group entries by (client, window_index) where window_index = floor(block / windowBlocks)
    const windowCounts = new Map<string, number>();
    const kept: FeedbackRow[] = [];

    for (const f of activeFeedback) {
      const windowIndex = Math.floor(f.created_at_block / windowBlocks);
      const key = `${f.client}:${windowIndex}`;
      const count = windowCounts.get(key) ?? 0;
      if (count < maxPerWindow) {
        windowCounts.set(key, count + 1);
        kept.push(f);
      }
      // else: rate-limited, excluded
    }

    rateExcluded = activeFeedback.length - kept.length;
    activeFeedback = kept;

    // Flag: rate spike — any client exceeded max in a window
    if (rateExcluded > 0) {
      flags.push("rate_spike");
    }
  }

  if (rateExcluded > 0) {
    exclusions.push({ reason: "rate", count: rateExcluded });
  }

  // ── Early exit: no entries left ─────────────────────────────────────────
  const totalExcluded = exclusions.reduce((s, e) => s + e.count, 0);
  if (activeFeedback.length === 0) {
    return {
      agent_id: agentId,
      lens_name: lensName,
      score: "0",
      included_count: 0,
      excluded_count: totalExcluded,
      exclusions,
      flags,
      config,
    };
  }

  // ── Step 4: Decay weighting ─────────────────────────────────────────────
  const { decay } = config;
  const LN2 = Math.LN2;

  const weights: number[] = activeFeedback.map((f) => {
    if (!decay.enabled) return 1.0;
    const ageBlocks = Math.max(0, currentBlock - f.created_at_block);
    return Math.exp((-LN2 * ageBlocks) / decay.half_life_blocks);
  });

  // ── Step 5: Reviewer weight (reserved) ─────────────────────────────────
  // weight.enabled and weight.weight_by_reviewer_score are reserved for future
  // implementation. Currently all reviewers have multiplier 1.0.
  const reviewerWeights: number[] = activeFeedback.map(() => 1.0);

  // ── Step 6: Aggregate ───────────────────────────────────────────────────
  // Weighted average using floating-point arithmetic (final score in WAD scale).
  // We compute: score = sum(wad_value_i * w_i) / sum(w_i)
  // To preserve precision with large WAD integers, we scale by 1e-18 for
  // intermediate float math and then scale back.
  const WAD_SCALE = 1e18;
  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < activeFeedback.length; i++) {
    const wadFloat = Number(parseBigInt(activeFeedback[i].wad_value)) / WAD_SCALE;
    const w = weights[i] * reviewerWeights[i];
    weightedSum += wadFloat * w;
    totalWeight += w;
  }

  let scoreString = "0";
  if (totalWeight > 0) {
    const scoreFloat = weightedSum / totalWeight;
    // Convert back to WAD integer string (truncate to integer)
    const scoreBigInt = BigInt(Math.trunc(scoreFloat * WAD_SCALE));
    scoreString = scoreBigInt.toString();
  }

  return {
    agent_id: agentId,
    lens_name: lensName,
    score: scoreString,
    included_count: activeFeedback.length,
    excluded_count: totalExcluded,
    exclusions,
    flags,
    config,
  };
}
