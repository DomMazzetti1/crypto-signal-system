import { TrendDirection } from "./ta";
import { BTCRegime } from "./regime";
import { fetchKlines, Kline } from "./bybit";

export interface GateBResult {
  passed: boolean;
  reason: string | null;
}

export interface GateBInput {
  alertType: string;
  symbol?: string;
  trend4h: TrendDirection;
  btcRegime: BTCRegime;
  atr1h: number;
  markPrice: number;
  rrTp1: number;
  rrTp2?: number;
  // Signal indicator values for regime-specific thresholds
  rsi?: number;
  adx1h?: number;
  volume?: number;
  sma20Volume?: number;
  btcRangePct12h?: number | null;
  // Time the candle that produced this signal closed. Used for the
  // day-of-week filter. Production callers can omit (defaults to now);
  // backtest callers MUST pass the historical bar time so the filters are
  // evaluated against the period the signal would have fired in.
  signalTime?: Date;
  // Composite score (0-100) from computeCompositeScore(). Used by the
  // sideways MR_LONG soft gate. Optional: when undefined, the soft gate
  // fails open (does not block). Production pipeline callers should pass
  // this; backtest / shadow callers may omit.
  compositeScore?: number;
}

// ─────────────────────────────────────────────────────────
// Validated rejection sets — derived from the 2-yr backtest
// (2024-03 → 2026-04, 2,075 signals across 52 symbols).
// See alchemy-tools/brain/pattern_analysis_2yr.md for full math.
// ─────────────────────────────────────────────────────────

// Symbols with negative or near-zero EV across the full 2-yr window.
// Hard ban: every signal on these symbols is dropped at the gate.
export const SYMBOL_BLACKLIST: ReadonlySet<string> = new Set([
  "BERAUSDT",   // 0.0% WR, -1.000R, n=22
  "CAKEUSDT",   // 12.2% WR, -0.657R, n=74
  "APTUSDT",    // 20.0% WR, -0.507R, n=50
  "RESOLVUSDT", // 26.2% WR, -0.375R, n=42
  "PIPPINUSDT", // 21.1% WR, -0.327R, n=19
  "ASTERUSDT",  // 27.8% WR, -0.324R, n=18
  "HYPEUSDT",   // 29.0% WR, -0.200R, n=31
  "LINKUSDT",   // 36.4% WR, -0.198R, n=55 (soft watchlist promoted)
  "ARBUSDT",    // 39.4% WR, -0.125R, n=71 (soft watchlist promoted)
]);

// UTC days of the week to avoid. OOS validation (April 2026) showed the
// original Mon+Tue avoid set did NOT hold out-of-sample: Mon came in at
// -0.116R deriv but +0.027R holdout (flipped sign), while Tue was -0.189R
// deriv and -0.144R holdout (still negative). Keep Tue only; Mon is
// statistically indistinguishable from zero on holdout and gets dropped.
// The hour-of-day avoid set was dropped entirely pending re-evaluation
// against a fresh week of live data (see brain/oos_validation_2026-04-08).
export const AVOID_DOWS_UTC: ReadonlySet<number> = new Set([2]);

// Minimum composite score required for a sideways-regime MR_LONG signal to
// pass. Below this threshold the signal is rejected with
// SIDEWAYS_MR_LONG_LOW_SCORE. OOS validation (April 2026) showed sideways
// MR_LONG as a whole still has negative derivation-period EV, but the
// holdout cohort split on composite_score=40 produced enough separation
// to justify a soft (score-based) gate rather than a hard ban.
const SIDEWAYS_MR_LONG_MIN_SCORE = 40;

export interface GateBVariant {
  allow_counter_trend?: boolean;
}

// BTC 12h range filter REMOVED 2026-04-09: OOS validation (see
// brain/oos_validation_2026-04-08.md) showed the filter was value-destructive
// on both derivation (-0.067R) and 2026 hold-out (-0.244R). It was first
// "disabled" via BTC_RANGE_FILTER_ENABLED=false in Vercel prod env on
// 2026-04-08, but the env toggle proved unreliable — 27 real signals
// (KERNEL/POL/SOL/PENGU/…) were still rejected with BTC_RANGE_POSITION_OUT_OF_RANGE
// in the 24h window before removal. `btc_range_pct_12h` is still COMPUTED on
// every SHORT decision and persisted for future analysis via computeBtcRangePosition(),
// it is just no longer used as a gate.

const BTC_RANGE_WINDOW_HOURS = 12;
const BTC_RANGE_MIN_DATA_BARS = 6;

export function calculateBtcRangePositionPct(
  bars: readonly Pick<Kline, "high" | "low" | "close">[]
): number | null {
  if (bars.length < BTC_RANGE_MIN_DATA_BARS) return null;

  const btc12hLow = Math.min(...bars.map((bar) => bar.low));
  const btc12hHigh = Math.max(...bars.map((bar) => bar.high));
  const btcAtSignal = bars[bars.length - 1]?.close;

  if (!Number.isFinite(btc12hLow) || !Number.isFinite(btc12hHigh) || !Number.isFinite(btcAtSignal)) {
    return null;
  }
  if (btc12hHigh <= btc12hLow) return null;

  return ((btcAtSignal - btc12hLow) / (btc12hHigh - btc12hLow)) * 100;
}

export async function computeBtcRangePosition(
  signalTime: Date
): Promise<number | null> {
  const closedHourBoundary = new Date(signalTime);
  closedHourBoundary.setUTCMinutes(0, 0, 0);

  const btcBars = await fetchKlines(
    "BTCUSDT",
    "60",
    BTC_RANGE_WINDOW_HOURS + 2,
    closedHourBoundary.getTime()
  );

  const closedBars = btcBars
    .filter((bar) => bar.startTime < closedHourBoundary.getTime())
    .slice(-BTC_RANGE_WINDOW_HOURS);

  return calculateBtcRangePositionPct(closedBars);
}

/**
 * Compute the BTC 12h range position for an executable SHORT signal and
 * return it for persistence on the decisions row. Returns null for LONG or
 * data-only alerts (we only persist the metric on executable shorts, which
 * matches the pre-removal behaviour). Never gates — kept purely as a data
 * collection hook so btc_range_pct_12h stays populated for future analysis.
 */
export async function getShortBtcRangePosition(
  symbol: string,
  alertType: string,
  signalTime: Date
): Promise<number | null> {
  const lowerType = alertType.toLowerCase();
  if (!lowerType.includes("short") || lowerType.includes("data")) {
    return null;
  }

  try {
    const rangePct = await computeBtcRangePosition(signalTime);
    if (rangePct == null) {
      console.warn(`[gate-b] ${symbol} BTC 12h range position unavailable — data collection only`);
    }
    return rangePct;
  } catch (err) {
    console.warn(`[gate-b] ${symbol} BTC 12h range position unavailable — data collection only:`, err);
    return null;
  }
}

export function runGateB(input: GateBInput, variant?: GateBVariant): GateBResult {
  const {
    alertType, trend4h, btcRegime,
    atr1h, markPrice, rrTp1, rrTp2, rsi, symbol,
  } = input;
  const lowerType = alertType.toLowerCase();
  const allowCounterTrend = variant?.allow_counter_trend ?? false;

  // Skip the new validated filters for data-only / shadow signals so we keep
  // collecting comparison data on rejected cohorts instead of going dark.
  const isDataOnly = lowerType.includes("_data");

  // ── Symbol blacklist (validated 2-yr backtest + OOS) ──
  if (!isDataOnly && symbol && SYMBOL_BLACKLIST.has(symbol)) {
    return {
      passed: false,
      reason: "SYMBOL_BLACKLIST",
    };
  }

  // ── Day-of-week gate (UTC) ────────────────────────────
  // Defaults to "now" so production callers don't need to pass anything;
  // backtest callers should pass the historical candle close time.
  const signalTime = input.signalTime ?? new Date();
  const utcDow = signalTime.getUTCDay();
  if (!isDataOnly && AVOID_DOWS_UTC.has(utcDow)) {
    return {
      passed: false,
      reason: "TUESDAY_AVOID",
    };
  }

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
    if (lowerType.includes("long") && !lowerType.includes("reversal") && trend4h === "bearish") {
      return { passed: false, reason: "LONG signal but 4H trend is bearish" };
    }
    // SQ_SHORT is profitable in bull regime (PF 1.57, WR 49.3%) — only block non-squeeze shorts
    if (lowerType.includes("short") && !lowerType.includes("sq_short") && trend4h === "bullish") {
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
  // With TP1 now at 0.5R, use the second target for minimum viability checks.
  // Fall back to rrTp1 for older callers that haven't been updated yet.
  const rrRounded = Math.round((rrTp2 ?? rrTp1) * 100) / 100;
  if (rrRounded < 0.8) {
    return {
      passed: false,
      reason: `R:R to TP2 too low: ${rrRounded} < 0.8`,
    };
  }

  // ── BTC 12h range position filter REMOVED 2026-04-09 ──
  // The 15-50% SHORT-only band was proven value-destructive on both the
  // derivation window (-0.067R) and the 2026 hold-out (-0.244R). It was
  // first "disabled" via the BTC_RANGE_FILTER_ENABLED env var on 2026-04-08
  // but the toggle was unreliable — 27 live rejections in the 24h window
  // before removal. Ref: brain/oos_validation_2026-04-08.md.
  // btc_range_pct_12h is still computed + stored for future analysis.

  // ── Regime-aware signal gating ────────────────────────

  if (btcRegime === "bear") {
    // BEAR: allow SQ_SHORT freely
    // SQ_LONG: blocked in bear regime — counter-trend long squeeze has no edge.
    // Use EXACT match (not substring) so that SQ_LONG_REVERSAL and
    // SQ_LONG_RELAXED variants are not mis-caught by this rule.
    if (lowerType === "sq_long") {
      return {
        passed: false,
        reason: "SQ_LONG blocked in bear regime",
      };
    }
    // MR_SHORT: blocked — 26.3% WR, -0.156R in 2yr backtest (n=76)
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

  if (btcRegime === "sideways") {
    // MR_LONG: soft gate by composite score. OOS validation (April 2026)
    // showed sideways MR_LONG has negative deriv-period EV but the holdout
    // cohort split on composite_score produced enough lift above 40 to
    // keep the setup alive on a score-gated basis instead of hard-banning.
    // If compositeScore is not supplied (e.g. backtest callers), fail open.
    if (lowerType.includes("mr_long") && input.compositeScore !== undefined) {
      if (input.compositeScore < SIDEWAYS_MR_LONG_MIN_SCORE) {
        return {
          passed: false,
          reason: "SIDEWAYS_MR_LONG_LOW_SCORE",
        };
      }
    }
    // MR_SHORT: validated edge in sideways (53.5% WR, +0.476R, n=101) — allow
    // SQ_SHORT: already blocked above
  }

  // Bull regime: no additional filters. The previous blanket MR_LONG/MR_SHORT
  // bull ban was dropped after OOS validation — the derivation-period sample
  // sizes (n=1, n=3) were too small to justify a hard rule, and the middle-path
  // filter stack relies on other gates (symbol blacklist, trend, composite score)
  // to handle these cases.

  return { passed: true, reason: null };
}
