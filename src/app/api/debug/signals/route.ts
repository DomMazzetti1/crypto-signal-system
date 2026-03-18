import { NextResponse } from "next/server";
import { fetchKlines } from "@/lib/bybit";
import { computeIndicators, detectSignals, SymbolIndicators } from "@/lib/signals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Diagnose why a signal was or wasn't detected at a specific time
// Usage: /api/debug/signals?symbol=ICPUSDT&hour=2026-03-18T09:00:00Z

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol");
  const hour = url.searchParams.get("hour");

  if (!symbol || !hour) {
    return NextResponse.json({ error: "Required: ?symbol=X&hour=2026-03-18T09:00:00Z" }, { status: 400 });
  }

  const targetTime = new Date(hour).getTime();
  if (isNaN(targetTime)) {
    return NextResponse.json({ error: "Invalid hour format" }, { status: 400 });
  }

  // Fetch candles
  const [candles1h, candles4h, candles1d] = await Promise.all([
    fetchKlines(symbol, "60", 200),
    fetchKlines(symbol, "240", 100),
    fetchKlines(symbol, "D", 100),
  ]);

  // Find the target candle index
  const targetIdx = candles1h.findIndex(c => c.startTime === targetTime);
  if (targetIdx === -1) {
    // Show available candle times around the target
    const nearby = candles1h
      .filter(c => Math.abs(c.startTime - targetTime) < 6 * 3600000)
      .map(c => new Date(c.startTime).toISOString());
    return NextResponse.json({
      error: "Target candle not found in data",
      target: new Date(targetTime).toISOString(),
      nearby_candles: nearby,
      total_1h_candles: candles1h.length,
      first: new Date(candles1h[0].startTime).toISOString(),
      last: new Date(candles1h[candles1h.length - 1].startTime).toISOString(),
    });
  }

  const targetCandle = candles1h[targetIdx];

  // Build the slice the scanner would have used:
  // filterConfirmed keeps candles with startTime < bucket start
  // The scanner at hour X would use candles with startTime < X
  // So the "current" candle at 09:00 would be the 08:00 candle (closed at 09:00)
  // But TradingView fires on the candle that just closed, which IS the target candle
  // So we include up to and including targetIdx
  const slice1h = candles1h.slice(0, targetIdx + 1);

  // For 4H: include candles whose start time <= target candle start time
  const slice4h = candles4h.filter(c => c.startTime <= targetTime);
  const slice1d = candles1d.filter(c => c.startTime <= targetTime);

  // Compute indicators
  const indicators = computeIndicators(slice1h, slice4h, slice1d);

  // Also compute what the scanner's filterConfirmed would give us
  // Scanner at 09:00 uses hourBucket = 09:00:00, so keeps startTime < 09:00:00
  // That means the 08:00 candle is the LATEST included, and the 09:00 candle is excluded
  const scannerSlice1h = candles1h.slice(0, targetIdx); // excludes target
  const scannerSlice4h = candles4h.filter(c => c.startTime < targetTime);
  const scannerSlice1d = candles1d.filter(c => c.startTime < targetTime);
  const scannerIndicators = computeIndicators(scannerSlice1h, scannerSlice4h, scannerSlice1d);

  // Run signal detection on both
  const signalsOnTarget = indicators ? detectSignals(symbol, indicators) : [];
  const signalsOnScanner = scannerIndicators ? detectSignals(symbol, scannerIndicators) : [];

  // Detailed condition check for each signal type
  function checkConditions(ind: SymbolIndicators) {
    return {
      MR_LONG: {
        close_lt_bb_lower: { value: ind.close, threshold: ind.bb_lower, pass: ind.close < ind.bb_lower },
        rsi_lt_29: { value: ind.rsi, threshold: 29, pass: ind.rsi < 29 },
        z_score_lt_neg2: { value: ind.z_score, threshold: -2.0, pass: ind.z_score < -2.0 },
        close_off_low_gte_025: { value: ind.close_off_low, threshold: 0.25, pass: ind.close_off_low >= 0.25 },
        volume_gt_sma20x12: { value: ind.volume, threshold: ind.sma20_volume * 1.2, pass: ind.volume > ind.sma20_volume * 1.2 },
        adx_1h_lt_18: { value: ind.adx_1h, threshold: 18, pass: ind.adx_1h < 18 },
        adx_4h_lt_22: { value: ind.adx_4h, threshold: 22, pass: ind.adx_4h < 22 },
        daily_veto: { ema50_1d: ind.ema50_1d, atr_1d: ind.atr_1d, pass: ind.ema50_1d === null || ind.close > ind.ema50_1d - 2.2 * ind.atr_1d },
      },
      MR_SHORT: {
        close_gt_bb_upper: { value: ind.close, threshold: ind.bb_upper, pass: ind.close > ind.bb_upper },
        rsi_gt_71: { value: ind.rsi, threshold: 71, pass: ind.rsi > 71 },
        z_score_gt_2: { value: ind.z_score, threshold: 2.0, pass: ind.z_score > 2.0 },
        close_off_high_gte_025: { value: ind.close_off_high, threshold: 0.25, pass: ind.close_off_high >= 0.25 },
        volume_gt_sma20x12: { value: ind.volume, threshold: ind.sma20_volume * 1.2, pass: ind.volume > ind.sma20_volume * 1.2 },
        adx_1h_lt_18: { value: ind.adx_1h, threshold: 18, pass: ind.adx_1h < 18 },
        adx_4h_lt_22: { value: ind.adx_4h, threshold: 22, pass: ind.adx_4h < 22 },
        daily_veto: { ema50_1d: ind.ema50_1d, atr_1d: ind.atr_1d, pass: ind.ema50_1d === null || ind.close < ind.ema50_1d + 2.2 * ind.atr_1d },
      },
      SQ_SHORT: {
        bb_width_lt_006: { value: ind.bb_width_ratio, threshold: 0.06, pass: ind.bb_width_ratio < 0.06 },
        bb_width_near_min: { value: ind.bb_width_near_min, pass: ind.bb_width_near_min },
        crossed_below_basis: { prev_close: ind.prev_close, prev_bb_basis: ind.prev_bb_basis, close: ind.close, bb_basis: ind.bb_basis, pass: ind.prev_close >= ind.prev_bb_basis && ind.close < ind.bb_basis },
        close_lt_ema20: { value: ind.close, threshold: ind.ema20, pass: ind.close < ind.ema20 },
        rsi_crossed_below_48: { prev_rsi: ind.prev_rsi, rsi: ind.rsi, pass: ind.prev_rsi >= 48 && ind.rsi < 48 },
        volume_gt_sma20x15: { value: ind.volume, threshold: ind.sma20_volume * 1.5, pass: ind.volume > ind.sma20_volume * 1.5 },
        adx_1h_lt_30: { value: ind.adx_1h, threshold: 30, pass: ind.adx_1h < 30 },
        close_4h_lt_ema50_4h: { value: ind.close_4h, threshold: ind.ema50_4h, pass: ind.close_4h < ind.ema50_4h },
        candle_range_lt_atr22: { value: ind.candle_range, threshold: ind.atr_1h * 2.2, pass: ind.candle_range < ind.atr_1h * 2.2 },
        close_near_ema20: { value: Math.abs(ind.close - ind.ema20), threshold: ind.atr_1h * 1.5, pass: Math.abs(ind.close - ind.ema20) < ind.atr_1h * 1.5 },
      },
      SQ_LONG_disabled: "SQ_LONG is disabled in live scanner",
    };
  }

  return NextResponse.json({
    symbol,
    target_time: new Date(targetTime).toISOString(),
    target_candle: {
      open: targetCandle.open,
      high: targetCandle.high,
      low: targetCandle.low,
      close: targetCandle.close,
      volume: targetCandle.volume,
    },
    // What TradingView would see (including the closed candle)
    tv_perspective: {
      candles_used: slice1h.length,
      indicators_computed: indicators !== null,
      signals_detected: signalsOnTarget.map(s => s.type),
      conditions: indicators ? checkConditions(indicators) : null,
      key_values: indicators ? {
        close: indicators.close,
        rsi: indicators.rsi,
        adx_1h: indicators.adx_1h,
        adx_4h: indicators.adx_4h,
        bb_upper: indicators.bb_upper,
        bb_lower: indicators.bb_lower,
        bb_basis: indicators.bb_basis,
        bb_width_ratio: indicators.bb_width_ratio,
        z_score: indicators.z_score,
        ema20: indicators.ema20,
        volume: indicators.volume,
        sma20_volume: indicators.sma20_volume,
        close_4h: indicators.close_4h,
        ema50_4h: indicators.ema50_4h,
        atr_1h: indicators.atr_1h,
      } : null,
    },
    // What our scanner would see (excluding current candle due to filterConfirmed)
    scanner_perspective: {
      candles_used: scannerSlice1h.length,
      indicators_computed: scannerIndicators !== null,
      signals_detected: signalsOnScanner.map(s => s.type),
      conditions: scannerIndicators ? checkConditions(scannerIndicators) : null,
      key_values: scannerIndicators ? {
        close: scannerIndicators.close,
        rsi: scannerIndicators.rsi,
        adx_1h: scannerIndicators.adx_1h,
        adx_4h: scannerIndicators.adx_4h,
        bb_upper: scannerIndicators.bb_upper,
        bb_lower: scannerIndicators.bb_lower,
        bb_basis: scannerIndicators.bb_basis,
        bb_width_ratio: scannerIndicators.bb_width_ratio,
        z_score: scannerIndicators.z_score,
        ema20: scannerIndicators.ema20,
        volume: scannerIndicators.volume,
        sma20_volume: scannerIndicators.sma20_volume,
        close_4h: scannerIndicators.close_4h,
        ema50_4h: scannerIndicators.ema50_4h,
        atr_1h: scannerIndicators.atr_1h,
      } : null,
    },
    explanation: {
      scanner_timing: "Scanner at hour X uses filterConfirmed(startTime < X), so the candle starting at X is EXCLUDED. The scanner evaluates the PREVIOUS candle as the most recent closed bar.",
      tv_timing: "TradingView fires alerts when a candle closes. An alert at 09:00 means the 08:00-09:00 candle just closed and IS included in TV's calculation.",
      key_difference: "Scanner runs on candle[i-1], TradingView runs on candle[i]. They see different 'latest' bars.",
    },
  });
}
