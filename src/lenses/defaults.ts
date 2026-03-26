/**
 * Default (pass-through) values for each lens dimension.
 *
 * These defaults apply no filtering and no weighting — all feedback passes
 * through and contributes equally to the score. Use mergeLensConfig() to
 * overlay partial configurations on these defaults.
 */

import type {
  TrustDimension,
  BoundsDimension,
  RateDimension,
  DecayDimension,
  WeightDimension,
  LensConfig,
} from "./types";

/** Default trust: accept all reviewers, no minimum count. */
export const DEFAULT_TRUST: TrustDimension = {
  approved_clients_only: false,
  min_feedback_count_per_reviewer: 0,
};

/** Default bounds: no min or max WAD value restrictions. */
export const DEFAULT_BOUNDS: BoundsDimension = {
  min_wad_value: null,
  max_wad_value: null,
};

/** Default rate: no per-reviewer rate limit, 144-block window. */
export const DEFAULT_RATE: RateDimension = {
  max_per_reviewer_per_window: null,
  window_blocks: 144,
};

/** Default decay: disabled, 1440-block half-life (≈ 10 days). */
export const DEFAULT_DECAY: DecayDimension = {
  enabled: false,
  half_life_blocks: 1440,
};

/** Default weight: disabled, no reviewer-score weighting. */
export const DEFAULT_WEIGHT: WeightDimension = {
  enabled: false,
  weight_by_reviewer_score: false,
};

/** Full default lens config — pass-through on all dimensions. */
export const DEFAULT_LENS_CONFIG: LensConfig = {
  trust: DEFAULT_TRUST,
  bounds: DEFAULT_BOUNDS,
  rate: DEFAULT_RATE,
  decay: DEFAULT_DECAY,
  weight: DEFAULT_WEIGHT,
};

/**
 * Merge a partial LensConfig with the defaults.
 *
 * Each dimension is merged shallowly — a partial dimension object overrides
 * only the specified keys. Omitted dimensions use the full default.
 */
export function mergeLensConfig(partial: Partial<LensConfig>): LensConfig {
  return {
    trust: { ...DEFAULT_TRUST, ...(partial.trust ?? {}) },
    bounds: { ...DEFAULT_BOUNDS, ...(partial.bounds ?? {}) },
    rate: { ...DEFAULT_RATE, ...(partial.rate ?? {}) },
    decay: { ...DEFAULT_DECAY, ...(partial.decay ?? {}) },
    weight: { ...DEFAULT_WEIGHT, ...(partial.weight ?? {}) },
  };
}

/**
 * Parse a JSON config string into a fully-merged LensConfig.
 * Returns the default config on parse failure.
 */
export function parseLensConfig(configJson: string): LensConfig {
  try {
    return mergeLensConfig(JSON.parse(configJson) as Partial<LensConfig>);
  } catch {
    return mergeLensConfig({});
  }
}
