/**
 * Composite Signal Score (0–100)
 *
 * Replaces the naive score = rr_tp1 with a bounded composite that uses
 * multiple available signal quality metrics.
 *
 * Formula:
 *   score = (rr_component * 0.35)
 *         + (vol_component * 0.35)
 *         + (tier_component * 0.20)
 *         - (deviation_penalty * 0.10)
 *
 * Each component is normalized to 0–100 before weighting.
 *
 * Components:
 *   rr_component:       rr_tp1 clamped to [0, 5], mapped to [0, 100]
 *                        rr_tp1=1.5 (minimum) → 30, rr_tp1=3.0 → 60, rr_tp1=5.0 → 100
 *   vol_component:      vol_ratio clamped to [0, 5], mapped to [0, 100]
 *                        vol_ratio=1.0 → 20, vol_ratio=2.0 → 40
 *   tier_component:     derived from tier (proxy for pass_count since exact
 *                        pass_count is not available in pipeline)
 *                        STRICT_PROD (9/9) → 100, RELAXED_PROD (~7/9) → 55, DATA_ONLY (~5/9) → 25
 *   deviation_penalty:  |entry_price - mark_price| / mark_price, clamped to [0, 0.02]
 *                        0% deviation → 0 penalty, 2%+ deviation → full 10-point penalty
 *
 * Missing inputs degrade gracefully: each missing component contributes 0
 * but the score is scaled up proportionally so missing data doesn't
 * systematically crush scores.
 */

export interface ScoreInput {
  rr_tp1: number | null;
  vol_ratio: number | null;
  /** The alert_type string, e.g. "SQ_SHORT" or "SQ_SHORT_RELAXED" */
  alert_type: string;
  entry_price: number | null;
  mark_price: number | null;
}

export interface ScoreResult {
  composite_score: number; // 0–100
  /** Raw component values before weighting (for debugging) */
  components: {
    rr: number;
    vol: number;
    tier: number;
    deviation_penalty: number;
  };
}

// Weights sum to 1.0
const W_RR = 0.35;
const W_VOL = 0.35;
const W_TIER = 0.20;
const W_DEV = 0.10;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function normalize(val: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp((val - min) / (max - min), 0, 1) * 100;
}

function tierScore(alertType: string): number {
  const upper = alertType.toUpperCase();
  if (upper.includes("_DATA")) return 25;
  if (upper.includes("_RELAXED")) return 55;
  // STRICT or base types (MR_LONG, MR_SHORT) are treated as strict-equivalent
  return 100;
}

export function computeCompositeScore(input: ScoreInput): ScoreResult {
  const rrRaw = input.rr_tp1 != null ? normalize(input.rr_tp1, 0, 5) : null;
  const volRaw = input.vol_ratio != null ? normalize(input.vol_ratio, 0, 5) : null;
  const tierRaw = tierScore(input.alert_type);

  let deviationPenalty = 0;
  if (
    input.entry_price != null &&
    input.mark_price != null &&
    input.mark_price > 0
  ) {
    const devPct = Math.abs(input.entry_price - input.mark_price) / input.mark_price;
    // 0% → 0 penalty, 2%+ → 100 (full penalty)
    deviationPenalty = normalize(devPct, 0, 0.02);
  }

  // Compute weighted score, handling missing components gracefully.
  // If a component is null, its weight is redistributed to available components
  // so missing data doesn't systematically crush scores.
  let totalWeight = W_TIER; // tier is always available
  let weightedSum = tierRaw * W_TIER;

  if (rrRaw != null) {
    weightedSum += rrRaw * W_RR;
    totalWeight += W_RR;
  }
  if (volRaw != null) {
    weightedSum += volRaw * W_VOL;
    totalWeight += W_VOL;
  }

  // Deviation penalty reduces score (0 if not computable)
  weightedSum -= deviationPenalty * W_DEV;

  // Scale: divide by available positive weight, yielding 0–100
  const finalScore = totalWeight > 0 ? clamp(weightedSum / totalWeight, 0, 100) : 0;

  return {
    composite_score: Math.round(finalScore * 100) / 100,
    components: {
      rr: rrRaw ?? 0,
      vol: volRaw ?? 0,
      tier: tierRaw,
      deviation_penalty: deviationPenalty,
    },
  };
}
