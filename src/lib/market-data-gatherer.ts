/**
 * Market Data Gatherer for AI Signal Review
 *
 * Collects comprehensive market context for Sonnet analysis:
 * - Multi-timeframe OHLCV candles (symbol + BTC)
 * - Computed structural hints (swing highs/lows, range positions)
 * - Volume analysis
 * - Funding rate and OI context
 */

import { fetchKlines, type Kline } from "@/lib/bybit";
import { type SignalContext } from "@/lib/signal-context";

// ── Types ──────────────────────────────────────────────────

export interface SwingLevel {
  price: number;
  time: number;
  type: "high" | "low";
}

export interface StructuralHints {
  swing_highs_24h: SwingLevel[];
  swing_lows_24h: SwingLevel[];
  swing_highs_7d: SwingLevel[];
  swing_lows_7d: SwingLevel[];
  nearest_swing_low: SwingLevel | null;
  nearest_swing_low_distance_pct: number | null;
  nearest_swing_low_tests: number;
  position_in_24h_range_pct: number | null;
  position_in_7d_range_pct: number | null;
}

export interface VolumeAnalysis {
  current_bar_volume: number;
  avg_20bar_volume: number;
  volume_ratio: number;
  signal_candle_high_volume: boolean;
}

export interface CandleSet {
  candles_1h_48h: Kline[];
  candles_4h_14d: Kline[];
  candles_1d_30d: Kline[];
}

export interface BTCContext {
  candles_1h_48h: Kline[];
  candles_4h_14d: Kline[];
  candles_1d_30d: Kline[];
  trend_labels: {
    trend_1h: string;
    trend_4h: string;
    trend_1d: string;
  };
}

export interface MarketContextPayload {
  symbol: CandleSet;
  structural_hints: StructuralHints;
  volume_analysis: VolumeAnalysis;
  btc_context: BTCContext;
  signal_metadata: {
    entry: number;
    stop: number;
    tp1: number;
    tp2: number;
    tp3: number;
    alert_type: string;
    bb_width: number;
    atr14_1h: number;
  };
  market_positioning: {
    funding_rate: number | null;
    funding_interval: number | null;
    oi_delta_1h_pct: number | null;
    oi_delta_4h_pct: number | null;
  };
}

// ── Swing detection ────────────────────────────────────────

function detectSwings(candles: Kline[], lookback: number = 3): { highs: SwingLevel[]; lows: SwingLevel[] } {
  const highs: SwingLevel[] = [];
  const lows: SwingLevel[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isHigh = false;
      }
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isLow = false;
      }
    }

    if (isHigh) {
      highs.push({ price: candles[i].high, time: candles[i].startTime, type: "high" });
    }
    if (isLow) {
      lows.push({ price: candles[i].low, time: candles[i].startTime, type: "low" });
    }
  }

  return { highs, lows };
}

function countLevelTests(candles: Kline[], level: number, tolerancePct: number = 0.3): number {
  const tolerance = level * (tolerancePct / 100);
  let tests = 0;
  for (const c of candles) {
    if (Math.abs(c.low - level) <= tolerance || Math.abs(c.close - level) <= tolerance) {
      tests++;
    }
  }
  return tests;
}

function computeRangePosition(candles: Kline[], currentPrice: number): number | null {
  if (candles.length === 0) return null;
  const high = Math.max(...candles.map(c => c.high));
  const low = Math.min(...candles.map(c => c.low));
  if (high === low) return 50;
  return ((currentPrice - low) / (high - low)) * 100;
}

function classifyTrend(candles: Kline[]): string {
  if (candles.length < 10) return "insufficient_data";
  const closes = candles.map(c => c.close);
  const recent = closes.slice(-5);
  const earlier = closes.slice(-10, -5);

  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const earlierAvg = earlier.reduce((s, v) => s + v, 0) / earlier.length;

  const changePct = ((recentAvg - earlierAvg) / earlierAvg) * 100;
  if (changePct > 1.5) return "uptrend";
  if (changePct < -1.5) return "downtrend";
  return "chop";
}

// ── Main gatherer ──────────────────────────────────────────

export async function gatherMarketContext(
  symbolName: string,
  signalMetadata: {
    entry: number;
    stop: number;
    tp1: number;
    tp2: number;
    tp3: number;
    alert_type: string;
    bb_width: number;
    atr14_1h: number;
  },
  signalContext: SignalContext
): Promise<MarketContextPayload> {
  // Fetch all candle data in parallel
  const [
    sym1h, sym4h, sym1d,
    btc1h, btc4h, btc1d,
  ] = await Promise.all([
    fetchKlines(symbolName, "60", 48),    // 1H last 48 bars = 48h
    fetchKlines(symbolName, "240", 84),   // 4H last 84 bars = 14 days
    fetchKlines(symbolName, "D", 30),     // 1D last 30 bars
    fetchKlines("BTCUSDT", "60", 48),
    fetchKlines("BTCUSDT", "240", 84),
    fetchKlines("BTCUSDT", "D", 30),
  ]);

  const currentPrice = signalMetadata.entry;

  // ── Structural hints ─────────────────────────────────────
  // 24h swings from 1H candles (last 24 bars)
  const recent24h = sym1h.slice(-24);
  const swings24h = detectSwings(recent24h, 2);

  // 7d swings from 4H candles (last 42 bars = 7 days)
  const recent7d = sym4h.slice(-42);
  const swings7d = detectSwings(recent7d, 2);

  // Find nearest swing low below current price
  const allLows = [...swings24h.lows, ...swings7d.lows]
    .filter(s => s.price < currentPrice)
    .sort((a, b) => b.price - a.price); // closest first

  const nearestSwingLow = allLows.length > 0 ? allLows[0] : null;
  const nearestSwingLowDistPct = nearestSwingLow
    ? ((currentPrice - nearestSwingLow.price) / currentPrice) * 100
    : null;

  // Count how many times the nearest level was tested
  const nearestSwingLowTests = nearestSwingLow
    ? countLevelTests([...sym1h, ...sym4h], nearestSwingLow.price)
    : 0;

  // Range position
  const pos24h = computeRangePosition(recent24h, currentPrice);
  const pos7d = computeRangePosition(recent7d, currentPrice);

  // ── Volume analysis ──────────────────────────────────────
  const volumes = sym1h.map(c => c.volume);
  const currentBarVol = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
  const avg20 = volumes.length >= 20
    ? volumes.slice(-20).reduce((s, v) => s + v, 0) / 20
    : volumes.reduce((s, v) => s + v, 0) / Math.max(volumes.length, 1);

  const volRatio = avg20 > 0 ? currentBarVol / avg20 : 0;

  // ── BTC trend labels ─────────────────────────────────────
  const btcTrend1h = classifyTrend(btc1h);
  const btcTrend4h = classifyTrend(btc4h);
  const btcTrend1d = classifyTrend(btc1d);

  return {
    symbol: {
      candles_1h_48h: sym1h,
      candles_4h_14d: sym4h,
      candles_1d_30d: sym1d,
    },
    structural_hints: {
      swing_highs_24h: swings24h.highs,
      swing_lows_24h: swings24h.lows,
      swing_highs_7d: swings7d.highs,
      swing_lows_7d: swings7d.lows,
      nearest_swing_low: nearestSwingLow,
      nearest_swing_low_distance_pct: nearestSwingLowDistPct,
      nearest_swing_low_tests: nearestSwingLowTests,
      position_in_24h_range_pct: pos24h,
      position_in_7d_range_pct: pos7d,
    },
    volume_analysis: {
      current_bar_volume: currentBarVol,
      avg_20bar_volume: avg20,
      volume_ratio: volRatio,
      signal_candle_high_volume: volRatio >= 2.0,
    },
    btc_context: {
      candles_1h_48h: btc1h,
      candles_4h_14d: btc4h,
      candles_1d_30d: btc1d,
      trend_labels: {
        trend_1h: btcTrend1h,
        trend_4h: btcTrend4h,
        trend_1d: btcTrend1d,
      },
    },
    signal_metadata: signalMetadata,
    market_positioning: {
      funding_rate: signalContext.funding_rate,
      funding_interval: signalContext.funding_interval,
      oi_delta_1h_pct: signalContext.oi_delta_1h_pct,
      oi_delta_4h_pct: signalContext.oi_delta_4h_pct,
    },
  };
}

// ── Format helpers for Sonnet prompt ───────────────────────

function formatCandles(candles: Kline[], label: string): string {
  if (candles.length === 0) return `${label}: no data`;

  const lines = candles.map(c => {
    const time = new Date(c.startTime).toISOString().slice(0, 16);
    return `  ${time} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${Math.round(c.volume)}`;
  });

  // Limit to most recent candles to manage token count
  const maxCandles = label.includes("1H") ? 24 : label.includes("4H") ? 42 : 30;
  const trimmed = lines.slice(-maxCandles);

  return `${label} (${trimmed.length} bars):\n${trimmed.join("\n")}`;
}

export function formatMarketContextForPrompt(ctx: MarketContextPayload): string {
  const h = ctx.structural_hints;
  const v = ctx.volume_analysis;
  const mp = ctx.market_positioning;
  const sm = ctx.signal_metadata;

  const sections: string[] = [];

  // Signal metadata
  sections.push(`=== SIGNAL METADATA ===
Alert Type: ${sm.alert_type}
Entry: ${sm.entry}
Stop: ${sm.stop}
TP1: ${sm.tp1} | TP2: ${sm.tp2} | TP3: ${sm.tp3}
BB Width: ${sm.bb_width}
ATR(14, 1H): ${sm.atr14_1h}`);

  // Symbol candles (abbreviated: last N bars of each timeframe)
  sections.push(`=== SYMBOL OHLCV ===
${formatCandles(ctx.symbol.candles_1h_48h, "1H candles")}

${formatCandles(ctx.symbol.candles_4h_14d, "4H candles")}

${formatCandles(ctx.symbol.candles_1d_30d, "1D candles")}`);

  // Structural hints
  const swingLowsStr = h.swing_lows_7d.map(s =>
    `  ${new Date(s.time).toISOString().slice(0, 10)} @ ${s.price}`
  ).join("\n") || "  none detected";
  const swingHighsStr = h.swing_highs_7d.map(s =>
    `  ${new Date(s.time).toISOString().slice(0, 10)} @ ${s.price}`
  ).join("\n") || "  none detected";

  sections.push(`=== STRUCTURAL HINTS ===
7D Swing Lows:
${swingLowsStr}
7D Swing Highs:
${swingHighsStr}
Nearest Swing Low: ${h.nearest_swing_low ? `${h.nearest_swing_low.price} (${h.nearest_swing_low_distance_pct?.toFixed(1)}% below current, tested ${h.nearest_swing_low_tests}x)` : "none"}
Position in 24H Range: ${h.position_in_24h_range_pct?.toFixed(0) ?? "N/A"}%
Position in 7D Range: ${h.position_in_7d_range_pct?.toFixed(0) ?? "N/A"}%`);

  // Volume
  sections.push(`=== VOLUME ===
Current Bar Volume: ${Math.round(v.current_bar_volume)}
20-Bar Avg Volume: ${Math.round(v.avg_20bar_volume)}
Volume Ratio: ${v.volume_ratio.toFixed(2)}x
High Volume Signal: ${v.signal_candle_high_volume ? "YES (2x+ avg)" : "no"}`);

  // BTC context
  const btcTrends = ctx.btc_context.trend_labels;
  sections.push(`=== BTC CONTEXT ===
BTC Trend 1H: ${btcTrends.trend_1h}
BTC Trend 4H: ${btcTrends.trend_4h}
BTC Trend 1D: ${btcTrends.trend_1d}

${formatCandles(ctx.btc_context.candles_1h_48h, "BTC 1H candles")}

${formatCandles(ctx.btc_context.candles_4h_14d, "BTC 4H candles")}

${formatCandles(ctx.btc_context.candles_1d_30d, "BTC 1D candles")}`);

  // Market positioning
  sections.push(`=== MARKET POSITIONING ===
Funding Rate: ${mp.funding_rate !== null ? (mp.funding_rate * 100).toFixed(4) + "%" : "N/A"}
Funding Interval: ${mp.funding_interval !== null ? mp.funding_interval + "h" : "N/A"}
OI Delta 1H: ${mp.oi_delta_1h_pct !== null ? mp.oi_delta_1h_pct.toFixed(2) + "%" : "N/A"}
OI Delta 4H: ${mp.oi_delta_4h_pct !== null ? mp.oi_delta_4h_pct.toFixed(2) + "%" : "N/A"}
Funding Direction: ${mp.funding_rate !== null ? (mp.funding_rate > 0 ? "positive (crowded longs)" : mp.funding_rate < 0 ? "negative (crowded shorts)" : "neutral") : "N/A"}`);

  return sections.join("\n\n");
}
