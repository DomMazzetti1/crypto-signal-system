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

export function runGateB(input: GateBInput): GateBResult {
  const {
    alertType, trend4h, btcRegime,
    atr1h, markPrice, rrTp1, rsi, adx1h, volume, sma20Volume,
  } = input;
  const lowerType = alertType.toLowerCase();

  // ── Directional trend filter ──────────────────────────
  if (lowerType.includes("long") && trend4h === "bearish") {
    return { passed: false, reason: "LONG signal but 4H trend is bearish" };
  }

  if (lowerType.includes("short") && trend4h === "bullish") {
    return { passed: false, reason: "SHORT signal but 4H trend is bullish" };
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
    // BEAR: allow SQ_SHORT, MR_SHORT freely
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
    // SQ_SHORT: require stronger volume confirmation (2.0x instead of 1.5x)
    if (lowerType.includes("sq_short") && volume !== undefined && sma20Volume !== undefined) {
      if (volume <= sma20Volume * 2.0) {
        return {
          passed: false,
          reason: `SQ_SHORT in SIDEWAYS regime requires volume > 2.0x SMA20 (${Math.round(volume)} <= ${Math.round(sma20Volume * 2.0)})`,
        };
      }
    }
  }

  return { passed: true, reason: null };
}
