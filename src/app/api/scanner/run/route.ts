import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getRedis, ALERTS_QUEUE_KEY } from "@/lib/redis";
import { fetchKlines, Kline } from "@/lib/bybit";
import { RSI, BollingerBands, EMA, ATR, ADX, SMA } from "trading-signals";
import { runPipeline, AlertPayload } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOCK_KEY = "scanner:lock";
const LOCK_TTL = 300;
const MAX_CONCURRENT = 8;

// ── Bucket helpers ──────────────────────────────────────

function currentHourBucket(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
}

function current4hBucket(): number {
  const now = new Date();
  const h = Math.floor(now.getUTCHours() / 4) * 4;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h));
  return d.getTime();
}

function currentDayBucket(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function filterConfirmed(candles: Kline[], bucketStart: number): Kline[] {
  return candles.filter((c) => c.startTime < bucketStart);
}

// ── Indicator computation ───────────────────────────────

interface SymbolIndicators {
  // 1H
  close: number;
  high: number;
  low: number;
  volume: number;
  prev_close: number;
  prev_rsi: number;
  rsi: number;
  bb_upper: number;
  bb_lower: number;
  bb_basis: number;
  prev_bb_basis: number;
  bb_width_ratio: number;
  bb_stdev: number;
  ema20: number;
  atr_1h: number;
  adx_1h: number;
  sma20_volume: number;
  z_score: number;
  close_off_low: number;
  close_off_high: number;
  bb_width_near_min: boolean;
  candle_range: number;
  // 4H
  close_4h: number;
  ema50_4h: number;
  adx_4h: number;
  // 1D
  ema50_1d: number | null;
  atr_1d: number;
  // metadata
  candle_start_time: number;
}

function computeIndicators(
  candles1h: Kline[],
  candles4h: Kline[],
  candles1d: Kline[]
): SymbolIndicators | null {
  if (candles1h.length < 30 || candles4h.length < 14 || candles1d.length < 14) {
    return null;
  }

  // ── 1H indicators ──
  const rsi = new RSI(14);
  const bb = new BollingerBands(20, 2.2);
  const ema20 = new EMA(20);
  const atr1h = new ATR(14);
  const adx1h = new ADX(14);
  const smaVol = new SMA(20);

  const bbWidths: number[] = [];
  let prevRsi = 50;
  let prevClose = candles1h[0].close;

  for (const c of candles1h) {
    rsi.update(c.close, false);
    bb.update(c.close, false);
    ema20.update(c.close, false);
    atr1h.update({ high: c.high, low: c.low, close: c.close }, false);
    adx1h.update({ high: c.high, low: c.low, close: c.close }, false);
    smaVol.update(c.volume, false);

    if (bb.isStable) {
      const r = bb.getResult();
      if (r) {
        const basis = Number(r.middle);
        const width = basis > 0 ? (Number(r.upper) - Number(r.lower)) / basis : 0;
        bbWidths.push(width);
      }
    }
  }

  if (!rsi.isStable || !bb.isStable || !atr1h.isStable || !adx1h.isStable) {
    return null;
  }

  // Get second-to-last RSI and BB basis for crossover detection
  const tempRsi = new RSI(14);
  const tempBb = new BollingerBands(20, 2.2);
  for (let i = 0; i < candles1h.length - 1; i++) {
    tempRsi.update(candles1h[i].close, false);
    tempBb.update(candles1h[i].close, false);
  }
  if (tempRsi.isStable) {
    prevRsi = Number(tempRsi.getResult() ?? 50);
  }
  prevClose = candles1h[candles1h.length - 2].close;

  const lastCandle = candles1h[candles1h.length - 1];
  const bbResult = bb.getResult()!;
  const bbUpper = Number(bbResult.upper);
  const bbLower = Number(bbResult.lower);
  const bbBasis = Number(bbResult.middle);
  const bbWidthRatio = bbBasis > 0 ? (bbUpper - bbLower) / bbBasis : 0;

  // Previous BB basis for crossover detection
  let prevBbBasis = bbBasis;
  if (tempBb.isStable) {
    const prevBbResult = tempBb.getResult();
    if (prevBbResult) prevBbBasis = Number(prevBbResult.middle);
  }

  // BB stdev from width
  // BB bands = basis ± multiplier * stdev, so stdev = (upper - basis) / multiplier
  const bbStdev = (bbUpper - bbBasis) / 2.2;

  // BB width percentile (near minimum of last 120)
  const recentWidths = bbWidths.slice(-120);
  const minWidth = Math.min(...recentWidths);
  const bbWidthNearMin = minWidth > 0
    ? bbWidthRatio <= minWidth * 1.15
    : false;

  const closeVal = lastCandle.close;
  const highVal = lastCandle.high;
  const lowVal = lastCandle.low;
  const range = highVal - lowVal;

  // ── 4H indicators ──
  const ema504h = new EMA(50);
  const adx4h = new ADX(14);
  for (const c of candles4h) {
    ema504h.update(c.close, false);
    adx4h.update({ high: c.high, low: c.low, close: c.close }, false);
  }

  if (!ema504h.isStable || !adx4h.isStable) return null;

  // ── 1D indicators ──
  const ema501d = new EMA(50);
  const atr1d = new ATR(14);
  for (const c of candles1d) {
    ema501d.update(c.close, false);
    atr1d.update({ high: c.high, low: c.low, close: c.close }, false);
  }

  // 1D EMA50 requires sufficient history — skip daily veto if not stable
  const ema50_1d_val = ema501d.isStable ? Number(ema501d.getResult()!) : null;
  const atr_1d_val = atr1d.isStable ? Number(atr1d.getResult()!) : Number(atr1h.getResult()!) * 4;

  return {
    close: closeVal,
    high: highVal,
    low: lowVal,
    volume: lastCandle.volume,
    prev_close: prevClose,
    prev_rsi: prevRsi,
    rsi: Number(rsi.getResult()!),
    bb_upper: bbUpper,
    bb_lower: bbLower,
    bb_basis: bbBasis,
    prev_bb_basis: prevBbBasis,
    bb_width_ratio: bbWidthRatio,
    bb_stdev: bbStdev,
    ema20: Number(ema20.getResult()!),
    atr_1h: Number(atr1h.getResult()!),
    adx_1h: Number(adx1h.getResult()!),
    sma20_volume: Number(smaVol.getResult()!),
    z_score: bbStdev > 0 ? (closeVal - bbBasis) / bbStdev : 0,
    close_off_low: range > 0 ? (closeVal - lowVal) / range : 0,
    close_off_high: range > 0 ? (highVal - closeVal) / range : 0,
    bb_width_near_min: bbWidthNearMin,
    candle_range: range,
    close_4h: candles4h[candles4h.length - 1].close,
    ema50_4h: Number(ema504h.getResult()!),
    adx_4h: Number(adx4h.getResult()!),
    ema50_1d: ema50_1d_val,
    atr_1d: atr_1d_val,
    candle_start_time: lastCandle.startTime,
  };
}

// ── Signal conditions ───────────────────────────────────

interface Signal {
  type: string;
  symbol: string;
  indicators: SymbolIndicators;
}

function detectSignals(symbol: string, ind: SymbolIndicators): Signal[] {
  const signals: Signal[] = [];

  // MR_LONG
  if (
    ind.close < ind.bb_lower &&
    ind.rsi < 29 &&
    ind.z_score < -2.0 &&
    ind.close_off_low >= 0.25 &&
    ind.volume > ind.sma20_volume * 1.2 &&
    ind.adx_1h < 18 &&
    ind.adx_4h < 22 &&
    (ind.ema50_1d === null || ind.close > ind.ema50_1d - 2.2 * ind.atr_1d)
  ) {
    signals.push({ type: "MR_LONG", symbol, indicators: ind });
  }

  // MR_SHORT
  if (
    ind.close > ind.bb_upper &&
    ind.rsi > 71 &&
    ind.z_score > 2.0 &&
    ind.close_off_high >= 0.25 &&
    ind.volume > ind.sma20_volume * 1.2 &&
    ind.adx_1h < 18 &&
    ind.adx_4h < 22 &&
    (ind.ema50_1d === null || ind.close < ind.ema50_1d + 2.2 * ind.atr_1d)
  ) {
    signals.push({ type: "MR_SHORT", symbol, indicators: ind });
  }

  // SQ_LONG
  const crossedAboveBasis = ind.prev_close <= ind.prev_bb_basis && ind.close > ind.bb_basis;
  const rsiCrossedAbove52 = ind.prev_rsi <= 52 && ind.rsi > 52;

  if (
    ind.bb_width_ratio < 0.06 &&
    ind.bb_width_near_min &&
    crossedAboveBasis &&
    ind.close > ind.ema20 &&
    rsiCrossedAbove52 &&
    ind.volume > ind.sma20_volume * 1.5 &&
    ind.adx_1h < 30 &&
    ind.close_4h > ind.ema50_4h &&
    ind.candle_range < ind.atr_1h * 2.2 &&
    Math.abs(ind.close - ind.ema20) < ind.atr_1h * 1.5
  ) {
    signals.push({ type: "SQ_LONG", symbol, indicators: ind });
  }

  // SQ_SHORT
  const crossedBelowBasis = ind.prev_close >= ind.prev_bb_basis && ind.close < ind.bb_basis;
  const rsiCrossedBelow48 = ind.prev_rsi >= 48 && ind.rsi < 48;

  if (
    ind.bb_width_ratio < 0.06 &&
    ind.bb_width_near_min &&
    crossedBelowBasis &&
    ind.close < ind.ema20 &&
    rsiCrossedBelow48 &&
    ind.volume > ind.sma20_volume * 1.5 &&
    ind.adx_1h < 30 &&
    ind.close_4h < ind.ema50_4h &&
    ind.candle_range < ind.atr_1h * 2.2 &&
    Math.abs(ind.close - ind.ema20) < ind.atr_1h * 1.5
  ) {
    signals.push({ type: "SQ_SHORT", symbol, indicators: ind });
  }

  return signals;
}

// ── Concurrency limiter ─────────────────────────────────

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Fetch with retry ────────────────────────────────────

async function fetchKlinesRetry(
  symbol: string,
  interval: string,
  limit: number
): Promise<Kline[]> {
  try {
    return await fetchKlines(symbol, interval, limit);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return fetchKlines(symbol, interval, limit);
  }
}

// ── Main handler ────────────────────────────────────────

export async function GET() {
  const startTime = Date.now();
  const redis = getRedis();
  const supabase = getSupabase();

  // 1. Acquire distributed lock
  const lockAcquired = await redis.set(LOCK_KEY, Date.now(), { nx: true, ex: LOCK_TTL });
  if (!lockAcquired) {
    return NextResponse.json({ status: "skipped_overlap" });
  }

  try {
    // 2. Read eligible symbols
    const { data: universeRows, error: uniError } = await supabase
      .from("universe")
      .select("symbol")
      .eq("is_eligible", true)
      .order("symbol");

    if (uniError || !universeRows) {
      return NextResponse.json({ error: "Failed to read universe" }, { status: 500 });
    }

    const symbols = universeRows.map((r) => r.symbol);
    const symbolErrors: { symbol: string; error: string }[] = [];
    let candidatesFound = 0;
    let candidatesQueued = 0;
    let skippedCooldown = 0;
    let skippedIdempotency = 0;

    const hourBucket = currentHourBucket();
    const fourHBucket = current4hBucket();
    const dayBucket = currentDayBucket();

    // 3-7. Process symbols with concurrency limit
    await runWithConcurrency(symbols, MAX_CONCURRENT, async (symbol) => {
      let candles1h: Kline[], candles4h: Kline[], candles1d: Kline[];
      try {
        [candles1h, candles4h, candles1d] = await Promise.all([
          fetchKlinesRetry(symbol, "60", 150),
          fetchKlinesRetry(symbol, "240", 50),
          fetchKlinesRetry(symbol, "D", 60),
        ]);
      } catch (err) {
        symbolErrors.push({ symbol, error: String(err) });
        return;
      }

      // 4. Filter to confirmed closed candles only
      candles1h = filterConfirmed(candles1h, hourBucket);
      candles4h = filterConfirmed(candles4h, fourHBucket);
      candles1d = filterConfirmed(candles1d, dayBucket);

      if (candles1h.length < 30) return;

      // 5. Calculate indicators
      const indicators = computeIndicators(candles1h, candles4h, candles1d);
      if (!indicators) return;

      // 6. Detect signals
      const signals = detectSignals(symbol, indicators);
      if (signals.length === 0) return;

      candidatesFound += signals.length;

      for (const sig of signals) {
        // 7a. Cooldown check
        const cooldownKey = `cooldown:${symbol}:${sig.type}`;
        const cooldownExists = await redis.get(cooldownKey);
        if (cooldownExists) {
          skippedCooldown++;
          continue;
        }

        // 7b. Idempotency check
        const candleTime = new Date(indicators.candle_start_time).toISOString();
        const { data: existing } = await supabase
          .from("candle_signals")
          .select("id")
          .eq("symbol", symbol)
          .eq("setup_type", sig.type)
          .eq("candle_start_time", candleTime)
          .limit(1)
          .single();

        if (existing) {
          skippedIdempotency++;
          continue;
        }

        // Build alert payload
        const alertPayload: AlertPayload = {
          type: sig.type,
          symbol,
          tf: "1H",
          price: indicators.close,
          rsi: indicators.rsi,
          adx1h: indicators.adx_1h,
          adx4h: indicators.adx_4h,
          bb_width: indicators.bb_width_ratio,
        };

        // Store in alerts_raw
        const { data: rawRow } = await supabase
          .from("alerts_raw")
          .insert({ payload: alertPayload })
          .select("id")
          .single();

        // Push to Redis queue
        await redis.lpush(ALERTS_QUEUE_KEY, JSON.stringify(alertPayload));

        // Run pipeline inline
        const alertId = rawRow?.id ?? null;
        try {
          const result = await runPipeline(alertPayload, alertId);
          // Only set cooldown and record idempotency on tradable decision
          if (result.decision === "LONG" || result.decision === "SHORT") {
            await redis.set(cooldownKey, Date.now(), { ex: 8 * 60 * 60 });
            await supabase.from("candle_signals").insert({
              symbol,
              setup_type: sig.type,
              candle_start_time: candleTime,
            });
          }
          candidatesQueued++;
          console.log(`[scanner] Queued: ${symbol} ${sig.type} close=${indicators.close}`);
        } catch (err) {
          console.error(`[scanner] Pipeline error for ${symbol} ${sig.type}:`, err);
        }
      }
    });

    const runtimeMs = Date.now() - startTime;

    // 9. Store scanner run
    await supabase.from("scanner_runs").insert({
      completed_at: new Date().toISOString(),
      symbols_scanned: symbols.length,
      candidates_found: candidatesFound,
      candidates_queued: candidatesQueued,
      symbol_errors: symbolErrors,
      runtime_ms: runtimeMs,
      status: "completed",
    });

    const summary = {
      scanned: symbols.length,
      candidates_found: candidatesFound,
      candidates_queued: candidatesQueued,
      skipped_cooldown: skippedCooldown,
      skipped_idempotency: skippedIdempotency,
      symbol_errors: symbolErrors,
      runtime_ms: runtimeMs,
    };

    console.log("[scanner] Complete:", JSON.stringify(summary));
    return NextResponse.json(summary);
  } finally {
    // 8. Release lock
    await redis.del(LOCK_KEY);
  }
}
