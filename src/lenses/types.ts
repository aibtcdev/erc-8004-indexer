/**
 * Lens configuration type definitions for ERC-8004 reputation lens system.
 *
 * A lens is a named, configurable view over raw feedback data that applies
 * filtering, weighting, and aggregation rules to produce a reputation score.
 *
 * The five dimensions:
 * - Trust:  Which reviewers' feedback to include.
 * - Bounds: Score range constraints (min/max WAD values accepted).
 * - Rate:   Rate limiting per reviewer per block window.
 * - Decay:  Time-based weighting (recent feedback weighted more heavily).
 * - Weight: Reviewer credibility weighting.
 */

/**
 * Trust dimension — controls which reviewer feedback counts.
 *
 * approved_clients_only: If true, only include feedback from clients listed
 *   in the client_approvals table for the queried agent.
 * min_feedback_count_per_reviewer: Minimum number of feedback entries a reviewer
 *   must have submitted (for this agent) to be included. 0 = no minimum.
 */
export interface TrustDimension {
  approved_clients_only: boolean;
  min_feedback_count_per_reviewer: number;
}

/**
 * Bounds dimension — constraints on acceptable raw WAD values.
 *
 * min_wad_value: Minimum acceptable wad_value (as TEXT decimal string, inclusive).
 *   Entries below this are excluded. null = no lower bound.
 * max_wad_value: Maximum acceptable wad_value (as TEXT decimal string, inclusive).
 *   Entries above this are excluded. null = no upper bound.
 */
export interface BoundsDimension {
  min_wad_value: string | null;
  max_wad_value: string | null;
}

/**
 * Rate dimension — rate limiting per reviewer per block window.
 *
 * max_per_reviewer_per_window: Maximum feedback entries to count per reviewer
 *   per window_blocks block window. null = no limit.
 *   When exceeded, only the first N entries (by created_at_block ASC) are kept.
 * window_blocks: Block window size. Default 144 (≈ 1 day on Stacks at ~10 min/block).
 */
export interface RateDimension {
  max_per_reviewer_per_window: number | null;
  window_blocks: number;
}

/**
 * Decay dimension — time-based exponential decay weighting.
 *
 * enabled: If false, all entries have equal weight (no decay).
 * half_life_blocks: Number of blocks for feedback weight to halve.
 *   weight = exp(-ln(2) * age_blocks / half_life_blocks)
 *   where age_blocks = currentBlock - created_at_block (floor 0).
 */
export interface DecayDimension {
  enabled: boolean;
  half_life_blocks: number;
}

/**
 * Weight dimension — reviewer credibility weighting.
 *
 * enabled: If false, all reviewers have equal weight (weight = 1.0).
 * weight_by_reviewer_score: If true, multiply entry weight by the reviewer's
 *   own aggregated score (reserved for future implementation).
 */
export interface WeightDimension {
  enabled: boolean;
  weight_by_reviewer_score: boolean;
}

/**
 * Full lens configuration combining all five dimensions.
 */
export interface LensConfig {
  trust: TrustDimension;
  bounds: BoundsDimension;
  rate: RateDimension;
  decay: DecayDimension;
  weight: WeightDimension;
}
