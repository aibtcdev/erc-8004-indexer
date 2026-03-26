/**
 * Reference "aibtc" lens configuration.
 *
 * This lens is the AIBTC ecosystem's recommended reputation view:
 * - Requires reviewers to be explicitly approved by the agent
 * - Requires at least 1 feedback entry per reviewer
 * - Bounds: ±100 WAD to exclude extreme outlier scores
 * - Rate: max 10 entries per reviewer per day (144 blocks)
 * - Decay: enabled with ~30-day half-life (4320 blocks at 10 min/block)
 * - Weight: disabled (all approved reviewers equally weighted)
 *
 * This config applies all 5 dimensions as a demonstration of the full pipeline.
 */

import type { LensConfig } from "./types";

export const AIBTC_LENS_CONFIG: LensConfig = {
  trust: {
    approved_clients_only: true,
    min_feedback_count_per_reviewer: 1,
  },
  bounds: {
    // ±100 WAD (100 * 10^18) — excludes extreme outliers
    min_wad_value: "-100000000000000000000",
    max_wad_value: "100000000000000000000",
  },
  rate: {
    max_per_reviewer_per_window: 10,
    window_blocks: 144, // ≈ 1 day on Stacks
  },
  decay: {
    enabled: true,
    half_life_blocks: 4320, // ≈ 30 days (144 blocks/day × 30)
  },
  weight: {
    enabled: false,
    weight_by_reviewer_score: false,
  },
};

export const AIBTC_LENS_META = {
  name: "aibtc",
  description:
    "AIBTC ecosystem reference lens: approved clients only, ±100 WAD bounds, rate-limited (10/day), 30-day decay.",
};
