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
import { GateBInput, GateBResult, runGateB } from "./gate-b";

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
// Delegates to the canonical runGateB with relaxed variant config.
// Only the sideways SQ_SHORT volume multiplier differs from production (1.5x vs 2.0x).

export function runGateBRelaxed(input: GateBInput): GateBResult {
  return runGateB(input, { sideways_sq_volume_mult: RELAXED_SIDEWAYS_SQ_VOLUME_MULT });
}
