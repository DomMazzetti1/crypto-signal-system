/**
 * Shadow-live evaluator for the relaxed variant.
 *
 * Evaluates whether a signal would pass under relaxed parameters
 * WITHOUT affecting production cooldown, Telegram, or decisions.
 *
 * Relaxed variant config (from backtest VARIANT_CONFIGS):
 *   cooldown_hours: 4
 *   sideways_sq_volume_mult: 1.5
 *   allow_counter_trend: false
 *
 * This module maintains its OWN cooldown state in Redis under a
 * separate key prefix ("shadow_cooldown:") so it never interferes
 * with production cooldown keys.
 */

import { getRedis } from "./redis";
import { GateBInput, GateBResult } from "./gate-b";

// ── Relaxed variant parameters ──────────────────────────
// Must match VARIANT_CONFIGS.relaxed in backtest/batch/route.ts
const RELAXED_COOLDOWN_TTL = 4 * 60 * 60; // 4 hours in seconds
const RELAXED_SIDEWAYS_SQ_VOLUME_MULT = 1.5;
const RELAXED_ALLOW_COUNTER_TREND = false;

// ── Shadow cooldown (separate Redis namespace) ──────────

function shadowCooldownKey(symbol: string, alertType: string): string {
  return `shadow_cooldown:${symbol}:${alertType}`;
}

export async function isShadowCooldownActive(
  symbol: string,
  alertType: string
): Promise<boolean> {
  const redis = getRedis();
  const val = await redis.get(shadowCooldownKey(symbol, alertType));
  return val !== null;
}

export async function setShadowCooldown(
  symbol: string,
  alertType: string
): Promise<void> {
  const redis = getRedis();
  await redis.set(shadowCooldownKey(symbol, alertType), Date.now(), {
    ex: RELAXED_COOLDOWN_TTL,
  });
}

// ── Relaxed Gate B ──────────────────────────────────────
// Reimplements Gate B with relaxed parameters.
// Only the sideways SQ_SHORT volume multiplier differs from production.
// Counter-trend filter is the same as baseline (allow_counter_trend = false).

export function runGateBRelaxed(input: GateBInput): GateBResult {
  const { alertType, trend4h, btcRegime, atr1h, markPrice, rrTp1, rsi, adx1h, volume, sma20Volume } = input;
  const lowerType = alertType.toLowerCase();

  // Directional trend filter (same as production — not relaxed)
  if (!RELAXED_ALLOW_COUNTER_TREND) {
    if (lowerType.includes("long") && trend4h === "bearish") {
      return { passed: false, reason: "LONG signal but 4H trend is bearish" };
    }
    if (lowerType.includes("short") && trend4h === "bullish") {
      return { passed: false, reason: "SHORT signal but 4H trend is bullish" };
    }
  }

  // ATR too low (unchanged)
  if (atr1h < 0.001 * markPrice) {
    return { passed: false, reason: `ATR too low: ${atr1h.toFixed(4)} < ${(0.001 * markPrice).toFixed(4)}` };
  }

  // R:R minimum (unchanged)
  const rrRounded = Math.round(rrTp1 * 100) / 100;
  if (rrRounded < 1.5) {
    return { passed: false, reason: `R:R to TP1 too low: ${rrRounded} < 1.5` };
  }

  // Regime-aware gating

  if (btcRegime === "bear") {
    if (lowerType.includes("mr_short")) {
      return { passed: false, reason: "MR_SHORT historically fails in bear regime" };
    }
    if (lowerType.includes("mr_long") && rsi !== undefined && rsi >= 25) {
      return { passed: false, reason: `MR_LONG in BEAR regime requires RSI < 25, got ${rsi.toFixed(1)}` };
    }
  }

  if (btcRegime === "bull") {
    if (lowerType.includes("sq_short")) {
      if (rsi !== undefined && rsi <= 75) {
        return { passed: false, reason: `SQ_SHORT in BULL regime requires RSI > 75, got ${rsi.toFixed(1)}` };
      }
      if (adx1h !== undefined && adx1h >= 15) {
        return { passed: false, reason: `SQ_SHORT in BULL regime requires ADX < 15, got ${adx1h.toFixed(1)}` };
      }
    }
  }

  // RELAXED: sideways SQ_SHORT volume multiplier = 1.5x (vs production 2.0x)
  if (btcRegime === "sideways") {
    if (lowerType.includes("sq_short") && volume !== undefined && sma20Volume !== undefined) {
      if (volume <= sma20Volume * RELAXED_SIDEWAYS_SQ_VOLUME_MULT) {
        return {
          passed: false,
          reason: `SQ_SHORT in SIDEWAYS requires volume > ${RELAXED_SIDEWAYS_SQ_VOLUME_MULT}x SMA20 (${Math.round(volume)} <= ${Math.round(sma20Volume * RELAXED_SIDEWAYS_SQ_VOLUME_MULT)})`,
        };
      }
    }
  }

  return { passed: true, reason: null };
}
