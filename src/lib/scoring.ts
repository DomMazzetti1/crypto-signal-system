/**
 * Composite Signal Score (0–100)
 *
 * Formula:
 *   score = (atr_pct_component * 0.35)
 *         + (vol_component     * 0.35)
 *         + (tier_component    * 0.20)
 *         - (deviation_penalty * 0.10)
 *
 * Components:
 *   atr_pct_component: ATR/price inverted and normalized over [0.1%, 4%]
 *     - ATR = 0.1% of price → score 100 (tight levels, high precision)
 *     - ATR = 2%   of price → score ~49
 *     - ATR = 4%+  of price → score 0  (wide noisy levels)
 *   vol_component: vol_ratio clamped to [0, 5], mapped to [0, 100]
 *   tier_component: STRICT → 100, RELAXED → 55, DATA_ONLY → 25
 *   deviation_penalty: always 0 currently (entry = markPrice by design)
 *     Will activate if entry is ever set to a non-mark price.
 */

export interface ScoreInput {
  /** ATR (1H, period 14) in price units */
  atr14_1h: number | null;
  /** Current mark price — used to compute ATR as % of price */
  mark_price: number | null;
  /** vol_ratio = current volume / SMA20 volume */
  vol_ratio: number | null;
  /** The alert_type string, e.g. "SQ_SHORT" or "SQ_SHORT_RELAXED" */
  alert_type: string;
}

export interface ScoreResult {
  composite_score: number; // 0–100
  /** Raw component values before weighting (for debugging) */
  components: {
    atr_pct: number;
    vol: number;
    tier: number;
    deviation_penalty: number;
  };
}

// Weights sum to 1.0
const W_ATR = 0.35;
const W_VOL = 0.35;
const W_TIER = 0.20;
const W_DEV = 0.10;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Non-linear vol_ratio scoring that penalizes the 2.0-2.5 dead zone.
 * Backtest data: dead zone PF 0.88 (losing), <2.0 PF 2.24-2.46, >2.5 strong.
 * Returns a raw score that gets normalized into the 0-100 composite range.
 */
function scoreVolRatio(volRatio: number | null): number {
  if (volRatio === null || volRatio === 0) return 0;
  // Dead zone: 2.0-2.5 — penalize heavily (PF 0.88 in backtest)
  if (volRatio >= 2.0 && volRatio < 2.5) return -5;
  // Below 1.5: good performance (PF 2.46 in backtest)
  if (volRatio < 1.5) return volRatio * 5; // 0-7.5 points
  // 1.5-2.0: decent (PF 2.24)
  if (volRatio < 2.0) return 7.5;
  // Above 2.5: strong volume confirmation
  return Math.min(volRatio * 3, 15); // 7.5-15 points, capped
}

function tierScore(alertType: string): number {
  const upper = alertType.toUpperCase();
  if (upper.includes("_DATA")) return 25;
  if (upper.includes("_RELAXED")) return 55;
  // STRICT or base types (MR_LONG, MR_SHORT) are treated as strict-equivalent
  return 100;
}

export function computeCompositeScore(input: ScoreInput): ScoreResult {
  // ATR% component: lower ATR% = tighter levels = higher score
  // Normalize over [0.001, 0.04] (0.1% to 4% of price — typical perp range)
  // Invert so that low ATR% maps to high score
  let atrPctRaw: number | null = null;
  if (input.atr14_1h != null && input.mark_price != null && input.mark_price > 0) {
    const atrPct = input.atr14_1h / input.mark_price;
    const clamped = Math.max(0.001, Math.min(0.04, atrPct));
    atrPctRaw = (1 - (clamped - 0.001) / (0.04 - 0.001)) * 100;
  }

  // Non-linear vol scoring: penalizes dead zone 2.0-2.5, rewards extremes
  // scoreVolRatio returns -5 to 15; map to 0-100 scale for weighting
  const volRaw = input.vol_ratio != null ? clamp((scoreVolRatio(input.vol_ratio) + 5) / 20 * 100, 0, 100) : null;
  const tierRaw = tierScore(input.alert_type);

  // Deviation penalty: currently always 0 because entry = markPrice.
  // Retained so it activates automatically if entry ever differs from mark.
  const deviationPenalty = 0;

  // Compute weighted score, handling missing components gracefully.
  // If a component is null, its weight is redistributed to available components
  // so missing data doesn't systematically crush scores.
  let totalWeight = W_TIER; // tier is always available
  let weightedSum = tierRaw * W_TIER;

  if (atrPctRaw != null) {
    weightedSum += atrPctRaw * W_ATR;
    totalWeight += W_ATR;
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
      atr_pct: atrPctRaw ?? 0,
      vol: volRaw ?? 0,
      tier: tierRaw,
      deviation_penalty: deviationPenalty,
    },
  };
}
