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
}

export interface GateBVariant {
  allow_counter_trend?: boolean;
}

export interface BtcRangeFilterConfig {
  enabled: boolean;
  low: number;
  high: number;
}

const BTC_RANGE_WINDOW_HOURS = 12;
const BTC_RANGE_MIN_DATA_BARS = 6;

function parseBound(raw: string | undefined, fallback: number): number {
  const parsed = raw == null ? Number.NaN : parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getBtcRangeFilterConfig(
  env: NodeJS.ProcessEnv = process.env
): BtcRangeFilterConfig {
  return {
    enabled: env.BTC_RANGE_FILTER_ENABLED !== "false",
    low: parseBound(env.BTC_RANGE_FILTER_LOW, 15),
    high: parseBound(env.BTC_RANGE_FILTER_HIGH, 50),
  };
}

export function shouldEvaluateBtcRangeFilter(
  alertType: string,
  config: BtcRangeFilterConfig = getBtcRangeFilterConfig()
): boolean {
  const lowerType = alertType.toLowerCase();
  return config.enabled && lowerType.includes("short") && !lowerType.includes("data");
}

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

export async function getShortBtcRangePosition(
  symbol: string,
  alertType: string,
  signalTime: Date,
  config: BtcRangeFilterConfig = getBtcRangeFilterConfig()
): Promise<number | null> {
  if (!shouldEvaluateBtcRangeFilter(alertType, config)) {
    return null;
  }

  try {
    const rangePct = await computeBtcRangePosition(signalTime);
    if (rangePct == null) {
      console.warn(`[gate-b] ${symbol} BTC 12h range position unavailable — fail open`);
    }
    return rangePct;
  } catch (err) {
    console.warn(`[gate-b] ${symbol} BTC 12h range position unavailable — fail open:`, err);
    return null;
  }
}

export function runGateB(input: GateBInput, variant?: GateBVariant): GateBResult {
  const {
    alertType, trend4h, btcRegime,
    atr1h, markPrice, rrTp1, rrTp2, rsi, btcRangePct12h, symbol,
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

  // ── BTC 12h range position filter (SHORT only) ───────
  const btcRangeConfig = getBtcRangeFilterConfig();
  if (shouldEvaluateBtcRangeFilter(alertType, btcRangeConfig) && btcRangePct12h != null) {
    if (btcRangePct12h < btcRangeConfig.low || btcRangePct12h > btcRangeConfig.high) {
      const logSymbol = symbol ?? alertType;
      console.log(
        `[gate-b] ${logSymbol} blocked: BTC at ${btcRangePct12h.toFixed(1)}% of 12h range ` +
        `(must be ${btcRangeConfig.low}-${btcRangeConfig.high}%)`
      );
      return {
        passed: false,
        reason: "BTC_RANGE_POSITION_OUT_OF_RANGE",
      };
    }
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
