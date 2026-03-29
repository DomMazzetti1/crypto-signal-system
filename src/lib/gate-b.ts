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
  sideways_sq_volume_mult?: number;
}

export function runGateB(input: GateBInput, variant?: GateBVariant): GateBResult {
  const {
    alertType, trend4h, btcRegime,
    atr1h, markPrice, rrTp1, rsi, adx1h, volume, sma20Volume,
  } = input;
  const lowerType = alertType.toLowerCase();
  const allowCounterTrend = variant?.allow_counter_trend ?? false;
  const sidewaysSqVolMult = variant?.sideways_sq_volume_mult ?? 2.0;

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
  const rrRounded = Math.round(rrTp1 * 100) / 100;
  if (rrRounded < 1.5) {
    return {
      passed: false,
      reason: `R:R to TP1 too low: ${rrRounded} < 1.5`,
    };
  }

  // ── Regime-aware signal gating ────────────────────────

  if (btcRegime === "bear") {
    // BEAR: allow SQ_SHORT freely
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

  if (btcRegime === "bull") {
    // BULL: allow MR_LONG, MR_SHORT freely
    // SQ_SHORT: restrict to RSI > 75 and ADX < 15
    if (lowerType.includes("sq_short")) {
      if (rsi !== undefined && rsi <= 75) {
        return {
          passed: false,
          reason: `SQ_SHORT in BULL regime requires RSI > 75, got ${rsi.toFixed(1)}`,
        };
      }
      if (adx1h !== undefined && adx1h >= 15) {
        return {
          passed: false,
          reason: `SQ_SHORT in BULL regime requires ADX < 15, got ${adx1h.toFixed(1)}`,
        };
      }
    }
  }

  if (btcRegime === "sideways") {
    // SIDEWAYS: allow MR_LONG, MR_SHORT freely (mean reversion preferred)
    // SQ_SHORT: volume confirmation varies by tier/variant
    if (lowerType.includes("sq_short") && volume !== undefined && sma20Volume !== undefined) {
      const isRelaxedTier = lowerType.includes("relaxed") || lowerType.includes("data");
      const volMult = isRelaxedTier ? 1.0 : sidewaysSqVolMult;
      if (volume <= sma20Volume * volMult) {
        return {
          passed: false,
          reason: `SQ_SHORT in SIDEWAYS regime requires volume > ${volMult}x SMA20 (${Math.round(volume)} <= ${Math.round(sma20Volume * volMult)})`,
        };
      }
    }
  }

  return { passed: true, reason: null };
}
