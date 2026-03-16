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
  const direction = alertType.toLowerCase();

  if (direction === "long" && trend4h === "bearish") {
    return { passed: false, reason: "LONG signal but 4H trend is bearish" };
  }

  if (direction === "short" && trend4h === "bullish") {
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

  // R:R minimum check
  if (rrTp1 < 1.5) {
    return {
      passed: false,
      reason: `R:R to TP1 too low: ${rrTp1.toFixed(2)} < 1.5`,
    };
  }

  return { passed: true, reason: null };
}
