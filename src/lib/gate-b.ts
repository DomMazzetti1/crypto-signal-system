import { TrendDirection } from "./ta";
import { AltEnvironment } from "./regime";

export interface GateBResult {
  passed: boolean;
  reason: string | null;
}

export function runGateB(
  alertType: string,
  trend4h: TrendDirection,
  altEnvironment: AltEnvironment,
  atr1h: number,
  markPrice: number,
  rrTp1: number
): GateBResult {
  const lowerType = alertType.toLowerCase();

  if (lowerType.includes("long") && trend4h === "bearish") {
    return { passed: false, reason: "LONG signal but 4H trend is bearish" };
  }

  if (lowerType.includes("short") && trend4h === "bullish") {
    return { passed: false, reason: "SHORT signal but 4H trend is bullish" };
  }

  if (altEnvironment === "hostile") {
    return { passed: false, reason: `alt_environment is hostile` };
  }

  // ATR too low — no movement
  if (atr1h < 0.001 * markPrice) {
    return {
      passed: false,
      reason: `ATR too low: ${atr1h.toFixed(4)} < ${(0.001 * markPrice).toFixed(4)}`,
    };
  }

  // R:R minimum check (round to 2dp to avoid floating point rejection)
  const rrRounded = Math.round(rrTp1 * 100) / 100;
  if (rrRounded < 1.5) {
    return {
      passed: false,
      reason: `R:R to TP1 too low: ${rrRounded} < 1.5`,
    };
  }

  return { passed: true, reason: null };
}
