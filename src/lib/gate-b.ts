import { TrendDirection } from "./ta";
import { BTCRegime } from "./regime";

export interface GateBResult {
  passed: boolean;
  reason: string | null;
}

export interface GateBInput {
  alertType: string;
  trend4h: TrendDirection;
  btcRegime: BTCRegime;
  atr1h: number;
  markPrice: number;
  rrTp1: number;
  // Signal indicator values for regime-specific thresholds
  rsi?: number;
  adx1h?: number;
  volume?: number;
  sma20Volume?: number;
}

export interface GateBVariant {
  allow_counter_trend?: boolean;
}

export function runGateB(input: GateBInput, variant?: GateBVariant): GateBResult {
  const {
    alertType, trend4h, btcRegime,
    atr1h, markPrice, rrTp1, rsi,
  } = input;
  const lowerType = alertType.toLowerCase();
  const allowCounterTrend = variant?.allow_counter_trend ?? false;

  // ── Sideways regime: block SQ_SHORT only ─────────────
  if (btcRegime.toLowerCase() === "sideways" && lowerType.includes("sq_short")) {
    return {
      passed: false,
      reason: "SQ_SHORT in SIDEWAYS regime has negative edge (PF 0.73, WR 37.7%) — blocked by regime filter",
    };
  }

  // ── Directional trend filter ──────────────────────────
  // Relaxed/data tiers bypass trend filter in data-collection mode
  const isRelaxedOrData = lowerType.includes("relaxed") || lowerType.includes("data");
  if (!isRelaxedOrData && !allowCounterTrend) {
    if (lowerType.includes("long") && trend4h === "bearish") {
      return { passed: false, reason: "LONG signal but 4H trend is bearish" };
    }
    if (lowerType.includes("short") && trend4h === "bullish") {
      return { passed: false, reason: "SHORT signal but 4H trend is bullish" };
    }
  }

  // ── ATR too low — no movement ─────────────────────────
  if (atr1h < 0.001 * markPrice) {
    return {
      passed: false,
      reason: `ATR too low: ${atr1h.toFixed(4)} < ${(0.001 * markPrice).toFixed(4)}`,
    };
  }

  // ── R:R minimum check ─────────────────────────────────
  // NOTE: rr_tp1 is now 1.0 after TP ladder tightening (was 1.5).
  // Guard retained for when entry is set to a non-mark price (e.g., limit order offset).
  const rrRounded = Math.round(rrTp1 * 100) / 100;
  if (rrRounded < 0.8) {
    return {
      passed: false,
      reason: `R:R to TP1 too low: ${rrRounded} < 0.8`,
    };
  }

  // ── Regime-aware signal gating ────────────────────────

  if (btcRegime === "bear") {
    // BEAR: allow SQ_SHORT freely
    // SQ_LONG: blocked in bear regime — counter-trend long squeeze has no edge
    if (lowerType.includes("sq_long")) {
      return {
        passed: false,
        reason: "SQ_LONG blocked in bear regime",
      };
    }
    // MR_SHORT: blocked — 0% win rate, -1.00R in backtest
    if (lowerType.includes("mr_short")) {
      return {
        passed: false,
        reason: "MR_SHORT historically fails in bear regime",
      };
    }
    // MR_LONG: restrict to RSI < 25
    if (lowerType.includes("mr_long") && rsi !== undefined && rsi >= 25) {
      return {
        passed: false,
        reason: `MR_LONG in BEAR regime requires RSI < 25, got ${rsi.toFixed(1)}`,
      };
    }
  }

  return { passed: true, reason: null };
}
