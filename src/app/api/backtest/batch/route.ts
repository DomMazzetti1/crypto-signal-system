import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";
import { SymbolIndicators, detectSignals } from "@/lib/signals";
import { RSI, BollingerBands, EMA, ATR, ADX, SMA } from "trading-signals";
import { classifyRegimeFromCandles, BTCRegime } from "@/lib/regime";
import { runGateB } from "@/lib/gate-b";
import { ema } from "@/lib/ta";
import { STRATEGY_PROFILE } from "@/lib/reviewer";
import { gradeSignal as gradeSignalLib } from "@/lib/grade-signal";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CONCURRENT = 4;
const WARMUP_BARS = 150;
const FORWARD_BARS = 48;
// ATR_MULT, TAKER_FEE, SLIPPAGE now applied internally by gradeSignalLib (grade-signal.ts)

// ── Variant configuration for frequency expansion experiments ──
// baseline = exact live parity. relaxed/aggressive = controlled expansion.
// NEVER applied to production code — backtest experimentation only.

interface VariantConfig {
  cooldown_hours: number;
  sideways_sq_volume_mult: number;
  allow_counter_trend: boolean;
}

const VARIANT_CONFIGS: Record<string, VariantConfig> = {
  baseline: {
    cooldown_hours: 8,
    sideways_sq_volume_mult: 2.0,
    allow_counter_trend: false,
  },
  relaxed: {
    cooldown_hours: 4,
    sideways_sq_volume_mult: 1.5,
    allow_counter_trend: false,
  },
  aggressive: {
    cooldown_hours: 2,
    sideways_sq_volume_mult: 1.2,
    allow_counter_trend: true,
  },
};

const VALID_VARIANTS = Object.keys(VARIANT_CONFIGS);

// Fixed BTC candle windows for regime classification
// Must match live classifyRegime() in regime.ts:19-21
const BTC_4H_WINDOW = 50;   // regime.ts:20 — fetchKlines("BTCUSDT", "240", 50)
const BTC_1D_WINDOW = 220;  // regime.ts:21 — fetchKlines("BTCUSDT", "D", 220)

// ── Types ───────────────────────────────────────────────

type ReviewerShadow = "HIGH_CONFIDENCE" | "MEDIUM_CONFIDENCE" | "LOW_CONFIDENCE";
type ReviewerShadowAction = "SEND" | "REVIEW" | "SKIP";

interface BacktestSignal {
  symbol: string;
  setup_type: string;
  candle_time: string;
  entry_price: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  hit_tp1: boolean;
  hit_tp2: boolean;
  hit_tp3: boolean;
  hit_sl: boolean;
  bars_to_resolution: number;
  max_favorable: number;
  max_adverse: number;
  regime: string;
  atr: number;
  reviewer_shadow: ReviewerShadow;
  reviewer_shadow_action: ReviewerShadowAction;
  is_disabled_setup: boolean;
}

// ── Deterministic reviewer shadow classification ────────
// NOT Claude parity. This is a rule-based approximation of
// what a reviewer would likely decide, using only fields
// available at signal time. Used for analytics segmentation.
//
// Scoring system: accumulate points from 0-10, then map to tiers.
// Each rule is derived from the reviewer's system prompt guidance
// and the STRATEGY_PROFILE regime rules.

interface ShadowInput {
  setup_type: string;       // MR_LONG, MR_SHORT, SQ_SHORT
  regime: string;           // bull, bear, sideways
  trend4h: string;          // bullish, bearish, neutral
  rsi: number;
  adx_1h: number;
  volume: number;
  sma20_volume: number;
  z_score: number;
  bb_width_ratio: number;
}

function classifyReviewerShadow(input: ShadowInput): {
  shadow: ReviewerShadow;
  action: ReviewerShadowAction;
  score: number;
} {
  let score = 5; // Start neutral

  const st = input.setup_type.toUpperCase();
  const volumeRatio = input.sma20_volume > 0 ? input.volume / input.sma20_volume : 1;

  // 1. Setup tier alignment (matches STRATEGY_PROFILE)
  //    Primary setup gets a boost, secondary is neutral, disabled is penalized
  if (st === "SQ_SHORT") score += 1;        // primary setup
  else if (st === "MR_SHORT") score += 0;    // secondary
  else if (st === "MR_LONG") score -= 2;     // disabled in most regimes

  // 2. Regime alignment (matches gate-b.ts regime rules)
  //    Favored combos get a boost, disfavored get penalized
  if (st === "SQ_SHORT" && input.regime === "bear") score += 2;
  if (st === "SQ_SHORT" && input.regime === "sideways") score += 1;
  if (st === "SQ_SHORT" && input.regime === "bull") score -= 2;   // restricted in bull
  if (st === "MR_SHORT" && input.regime === "sideways") score += 1;
  if (st === "MR_LONG" && input.regime === "bear") score -= 1;    // extreme restriction

  // 3. Trend alignment (reviewer checks if indicators align with direction)
  //    SHORT signals in bearish trend = aligned
  //    SHORT signals in bullish trend = misaligned (Gate B blocks this, but edge cases)
  if (st.includes("SHORT") && input.trend4h === "bearish") score += 1;
  if (st.includes("SHORT") && input.trend4h === "neutral") score += 0;
  if (st.includes("LONG") && input.trend4h === "bullish") score += 1;

  // 4. Volume confirmation strength
  //    Higher volume ratio = more conviction
  if (volumeRatio >= 3.0) score += 1;
  else if (volumeRatio < 1.5) score -= 1;

  // 5. RSI extremity (more extreme = stronger mean reversion signal)
  if (st.includes("MR_SHORT") && input.rsi > 75) score += 1;
  if (st.includes("MR_LONG") && input.rsi < 25) score += 1;
  if (st === "SQ_SHORT" && input.rsi < 45) score += 1;  // squeeze shorts favor low RSI

  // 6. ADX assessment (reviewer considers trend strength)
  //    Low ADX for MR setups = good (ranging market favors mean reversion)
  //    Very low ADX for SQ_SHORT = good (squeeze needs low volatility)
  if (st.includes("MR") && input.adx_1h < 15) score += 1;
  if (st === "SQ_SHORT" && input.adx_1h < 20) score += 1;

  // Clamp to 0-10
  score = Math.max(0, Math.min(10, score));

  // Map score to tiers
  let shadow: ReviewerShadow;
  let action: ReviewerShadowAction;

  if (score >= 7) {
    shadow = "HIGH_CONFIDENCE";
    action = "SEND";
  } else if (score >= 4) {
    shadow = "MEDIUM_CONFIDENCE";
    action = "REVIEW";
  } else {
    shadow = "LOW_CONFIDENCE";
    action = "SKIP";
  }

  return { shadow, action, score };
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

// ── Target candle counts for 1 year of data ────────────

const TARGET_CANDLES: Record<string, number> = {
  "60": 8760,
  "240": 2190,
  "D": 400,
};

const BYBIT_BATCH = 1000;

// ── Candle cache freshness: candles older than this are stable ───

const CACHE_FRESH_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// ── Read candles from Supabase cache ────────────────────

async function readCache(
  symbol: string,
  interval: string
): Promise<Kline[]> {
  const supabase = getSupabase();
  const rows: Kline[] = [];
  let offset = 0;
  const PAGE = 1000;

  // Paginate through all cached rows for this symbol+interval
  while (true) {
    const { data, error } = await supabase
      .from("candle_cache")
      .select("start_time, open, high, low, close, volume")
      .eq("symbol", symbol)
      .eq("interval", interval)
      .order("start_time", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error || !data) break;
    for (const r of data) {
      rows.push({
        startTime: new Date(r.start_time).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      });
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return rows;
}

// ── Write candles to Supabase cache ─────────────────────

async function writeCache(
  symbol: string,
  interval: string,
  candles: Kline[]
): Promise<void> {
  if (candles.length === 0) return;
  const supabase = getSupabase();

  for (let i = 0; i < candles.length; i += 500) {
    const batch = candles.slice(i, i + 500).map((c) => ({
      symbol,
      interval,
      start_time: new Date(c.startTime).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    await supabase
      .from("candle_cache")
      .upsert(batch, { onConflict: "symbol,interval,start_time", ignoreDuplicates: true });
  }
}

// ── Fetch from Bybit API (raw paginated, no cache) ─────

async function fetchFromBybit(
  symbol: string,
  interval: string,
  target: number,
  endParam?: number
): Promise<Kline[]> {
  const allCandles: Map<number, Kline> = new Map();
  let end = endParam;

  while (allCandles.size < target) {
    const batchSize = Math.min(BYBIT_BATCH, target - allCandles.size);
    let url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${batchSize}`;
    if (end !== undefined) {
      url += `&end=${end}`;
    }

    let data: { retCode: number; retMsg: string; result: { list: string[][] } };
    try {
      const res = await fetch(url, { cache: "no-store" });
      data = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(url, { cache: "no-store" });
      data = await res.json();
    }

    if (data.retCode !== 0) {
      throw new Error(`Kline fetch failed for ${symbol} (${interval}): ${data.retMsg}`);
    }

    const batch = data.result.list;
    if (batch.length === 0) break;

    for (const k of batch) {
      const startTime = Number(k[0]);
      if (!allCandles.has(startTime)) {
        allCandles.set(startTime, {
          startTime,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
      }
    }

    const earliestTime = Number(batch[batch.length - 1][0]);
    if (end !== undefined && earliestTime >= end) break;
    end = earliestTime - 1;
  }

  return Array.from(allCandles.values()).sort((a, b) => a.startTime - b.startTime);
}

// ── Paginated kline fetch with cache ────────────────────

async function fetchKlinesPaginated(
  symbol: string,
  interval: string,
  target?: number
): Promise<Kline[]> {
  const totalNeeded = target ?? TARGET_CANDLES[interval] ?? 1000;
  const now = Date.now();
  const freshBoundary = now - CACHE_FRESH_MS;

  // 1. Read existing cache
  const cached = await readCache(symbol, interval);

  // 2. Split cached candles: stable (old enough) vs stale (recent, need refresh)
  const stableCandles = cached.filter((c) => c.startTime < freshBoundary);
  const staleCount = cached.length - stableCandles.length;

  // 3. Determine what to fetch from Bybit
  let freshCandles: Kline[] = [];

  if (stableCandles.length >= totalNeeded) {
    // Cache fully covers the historical window
    if (staleCount > 0) {
      // Refresh only the stale (recent) candles
      freshCandles = await fetchFromBybit(symbol, interval, staleCount + 10);
      await writeCache(symbol, interval, freshCandles);
      console.log(`[cache] ${symbol}/${interval}: ${stableCandles.length} cached, refreshed ${freshCandles.length} recent`);
    } else {
      // All candles are stable — no Bybit fetch needed
      console.log(`[cache] ${symbol}/${interval}: ${stableCandles.length} cached, fully stable — no fetch needed`);
    }
  } else if (stableCandles.length > 0) {
    // Partial cache — fetch only the gap (older candles we're missing)
    const oldestCached = stableCandles[0].startTime;
    const missingCount = totalNeeded - stableCandles.length;
    // Fetch older candles ending before our earliest cached candle
    const olderCandles = await fetchFromBybit(symbol, interval, missingCount, oldestCached - 1);
    // Also refresh recent candles
    const recentCandles = await fetchFromBybit(symbol, interval, Math.max(staleCount + 50, 100));
    freshCandles = [...olderCandles, ...recentCandles];
    await writeCache(symbol, interval, freshCandles);
    console.log(`[cache] ${symbol}/${interval}: ${stableCandles.length} cached, fetched ${olderCandles.length} older + ${recentCandles.length} recent`);
  } else {
    // Empty cache — full fetch from Bybit
    freshCandles = await fetchFromBybit(symbol, interval, totalNeeded);
    await writeCache(symbol, interval, freshCandles);
    console.log(`[cache] ${symbol}/${interval}: cold start, fetched ${freshCandles.length} candles`);
  }

  // 4. Merge cached + fresh, deduplicate by startTime, sort chronologically
  const merged = new Map<number, Kline>();
  for (const c of stableCandles) merged.set(c.startTime, c);
  for (const c of freshCandles) merged.set(c.startTime, c); // fresh overwrites stale
  return Array.from(merged.values()).sort((a, b) => a.startTime - b.startTime);
}

// ── Precomputed indicator frame for O(n) backtest ───────
// Runs each indicator once over the full candle series and stores
// all intermediate values. The bar-walk loop then indexes into
// these arrays instead of calling computeIndicators(slice) per bar.
//
// Produces the EXACT same SymbolIndicators values as computeIndicators()
// because it uses the same library classes with the same parameters.

function precomputeIndicatorFrame(
  candles1h: Kline[],
  candles4h: Kline[],
  candles1d: Kline[]
): (SymbolIndicators | null)[] {
  const n = candles1h.length;
  const frame: (SymbolIndicators | null)[] = new Array(n).fill(null);

  // 1H indicator instances — created once, updated incrementally
  const rsi = new RSI(14);
  const bb = new BollingerBands(20, 2.2);
  const ema20Ind = new EMA(20);
  const atr1hInd = new ATR(14);
  const adx1hInd = new ADX(14);
  const smaVol = new SMA(20);

  // Rolling state for BB width near-min (last 120 widths)
  const bbWidths: number[] = [];

  // Previous-bar state for crossover detection
  let prevRsi = 50;
  let prevClose = 0;
  let prevBbBasis = 0;

  // 4H/1D precomputation — walk once, store per-index results
  // Build lookup: for each 1H bar index, find the latest 4H/1D candle index
  const ema504h = new EMA(50);
  const adx4hInd = new ADX(14);
  const htf4hResults: { close: number; ema50: number; adx: number; stable: boolean }[] = [];

  for (const c of candles4h) {
    ema504h.update(c.close, false);
    adx4hInd.update({ high: c.high, low: c.low, close: c.close }, false);
    htf4hResults.push({
      close: c.close,
      ema50: ema504h.isStable ? Number(ema504h.getResult()!) : 0,
      adx: adx4hInd.isStable ? Number(adx4hInd.getResult()!) : 0,
      stable: ema504h.isStable && adx4hInd.isStable,
    });
  }

  const ema501d = new EMA(50);
  const atr1dInd = new ATR(14);
  const htf1dResults: { ema50: number | null; atr: number; stable: boolean }[] = [];

  for (const c of candles1d) {
    ema501d.update(c.close, false);
    atr1dInd.update({ high: c.high, low: c.low, close: c.close }, false);
    htf1dResults.push({
      ema50: ema501d.isStable ? Number(ema501d.getResult()!) : null,
      atr: atr1dInd.isStable ? Number(atr1dInd.getResult()!) : 0,
      stable: ema501d.isStable || atr1dInd.isStable,
    });
  }

  // Walk through 1H candles, building the frame
  for (let i = 0; i < n; i++) {
    const c = candles1h[i];

    // Save prev values BEFORE updating current bar's indicators
    if (i > 0) {
      prevClose = candles1h[i - 1].close;
      if (rsi.isStable) {
        prevRsi = Number(rsi.getResult()!);
      }
      if (bb.isStable) {
        const prevBb = bb.getResult();
        if (prevBb) prevBbBasis = Number(prevBb.middle);
      }
    }

    // Update all 1H indicators with current bar
    rsi.update(c.close, false);
    bb.update(c.close, false);
    ema20Ind.update(c.close, false);
    atr1hInd.update({ high: c.high, low: c.low, close: c.close }, false);
    adx1hInd.update({ high: c.high, low: c.low, close: c.close }, false);
    smaVol.update(c.volume, false);

    // Track BB widths for near-min check
    if (bb.isStable) {
      const bbR = bb.getResult();
      if (bbR) {
        const basis = Number(bbR.middle);
        const width = basis > 0 ? (Number(bbR.upper) - Number(bbR.lower)) / basis : 0;
        bbWidths.push(width);
      }
    }

    // Skip bars where indicators aren't stable yet
    if (!rsi.isStable || !bb.isStable || !atr1hInd.isStable || !adx1hInd.isStable) {
      continue;
    }
    if (i === 0) continue; // Need prev values

    // Find latest 4H candle at or before this 1H bar
    const currentBarTime = c.startTime;
    let htf4hIdx = -1;
    for (let j = candles4h.length - 1; j >= 0; j--) {
      if (candles4h[j].startTime <= currentBarTime) {
        htf4hIdx = j;
        break;
      }
    }

    let htf1dIdx = -1;
    for (let j = candles1d.length - 1; j >= 0; j--) {
      if (candles1d[j].startTime <= currentBarTime) {
        htf1dIdx = j;
        break;
      }
    }

    // Need at least 14 4H and 14 1D candles
    if (htf4hIdx < 13 || htf1dIdx < 13) continue;
    if (!htf4hResults[htf4hIdx].stable) continue;

    const bbResult = bb.getResult()!;
    const bbUpper = Number(bbResult.upper);
    const bbLower = Number(bbResult.lower);
    const bbBasis = Number(bbResult.middle);
    const bbWidthRatio = bbBasis > 0 ? (bbUpper - bbLower) / bbBasis : 0;
    const bbStdev = (bbUpper - bbBasis) / 2.2;

    const recentWidths = bbWidths.slice(-120);
    const minWidth = recentWidths.length > 0 ? Math.min(...recentWidths) : 0;
    const bbWidthNearMin = minWidth > 0 ? bbWidthRatio <= minWidth * 1.15 : false;

    const range = c.high - c.low;
    const atr1hVal = Number(atr1hInd.getResult()!);

    const htf4h = htf4hResults[htf4hIdx];
    const htf1d = htf1dResults[htf1dIdx];

    frame[i] = {
      close: c.close,
      high: c.high,
      low: c.low,
      volume: c.volume,
      prev_close: prevClose,
      prev_rsi: prevRsi,
      rsi: Number(rsi.getResult()!),
      bb_upper: bbUpper,
      bb_lower: bbLower,
      bb_basis: bbBasis,
      prev_bb_basis: prevBbBasis,
      bb_width_ratio: bbWidthRatio,
      bb_stdev: bbStdev,
      ema20: Number(ema20Ind.getResult()!),
      atr_1h: atr1hVal,
      adx_1h: Number(adx1hInd.getResult()!),
      sma20_volume: Number(smaVol.getResult()!),
      z_score: bbStdev > 0 ? (c.close - bbBasis) / bbStdev : 0,
      close_off_low: range > 0 ? (c.close - c.low) / range : 0,
      close_off_high: range > 0 ? (c.high - c.close) / range : 0,
      bb_width_near_min: bbWidthNearMin,
      candle_range: range,
      close_4h: htf4h.close,
      ema50_4h: htf4h.ema50,
      adx_4h: htf4h.adx,
      ema50_1d: htf1d.ema50,
      atr_1d: htf1d.atr > 0 ? htf1d.atr : atr1hVal * 4,
      candle_start_time: c.startTime,
    };
  }

  return frame;
}

// ── Precomputed symbol 4H trend frame ───────────────────
// Computes 4H trend once per 4H candle, then maps each 1H bar
// to the trend at that point via the latest 4H candle index.

function precompute4hTrendFrame(
  candles4h: Kline[],
  candles1h: Kline[]
): { trend: "bullish" | "bearish" | "neutral" }[] {
  const n = candles1h.length;
  const frame: { trend: "bullish" | "bearish" | "neutral" }[] = new Array(n).fill({ trend: "neutral" as const });

  // Compute trend at each 4H candle index (incremental EMA)
  const closes4h = candles4h.map((c) => c.close);
  const ema20_4h = ema(closes4h, 20);
  const ema50_4h = ema(closes4h, 50);

  // Build per-4H-candle trend results
  const trendAt4h: { trend: "bullish" | "bearish" | "neutral" }[] = [];
  for (let j = 0; j < candles4h.length; j++) {
    const close = closes4h[j];
    const e20 = ema20_4h[j];
    const e50 = ema50_4h[j];
    let trend: "bullish" | "bearish" | "neutral" = "neutral";
    if (e20 !== undefined && e50 !== undefined) {
      if (close > e50 && e20 >= e50) trend = "bullish";
      else if (close < e50 && e20 <= e50) trend = "bearish";
    }
    trendAt4h.push({ trend });
  }

  // Map each 1H bar to the latest 4H candle's trend
  let lastIdx = -1;
  for (let i = 0; i < n; i++) {
    const barTime = candles1h[i].startTime;

    // Advance to the latest 4H candle at or before this 1H bar
    while (lastIdx + 1 < candles4h.length && candles4h[lastIdx + 1].startTime <= barTime) {
      lastIdx++;
    }

    if (lastIdx >= 0) {
      frame[i] = trendAt4h[lastIdx];
    }
  }

  return frame;
}

// ── Grade a signal against future bars ──────────────────

function computeRBacktest(sig: BacktestSignal): number {
  const risk = Math.abs(sig.entry_price - sig.stop_loss);
  if (risk === 0) return 0;
  if (sig.hit_tp3) return Math.abs(sig.tp3 - sig.entry_price) / risk;
  if (sig.hit_tp2) return Math.abs(sig.tp2 - sig.entry_price) / risk;
  if (sig.hit_tp1) return Math.abs(sig.tp1 - sig.entry_price) / risk;
  if (sig.hit_sl) return -1;
  return 0;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── Main handler ────────────────────────────────────────

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const supabase = getSupabase();

  // Parse symbols from query string
  const symbolsParam = request.nextUrl.searchParams.get("symbols");
  if (!symbolsParam) {
    return NextResponse.json(
      { error: "Missing ?symbols= parameter. Provide comma-separated symbols, e.g. ?symbols=BTCUSDT,SOLUSDT" },
      { status: 400 }
    );
  }

  const symbols = symbolsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) {
    return NextResponse.json({ error: "No valid symbols provided" }, { status: 400 });
  }

  const runGroupId = request.nextUrl.searchParams.get("run_group_id");
  if (!runGroupId) {
    return NextResponse.json(
      { error: "Missing required ?run_group_id= parameter. Every batch must belong to a named experiment group." },
      { status: 400 }
    );
  }

  const variantParam = request.nextUrl.searchParams.get("variant") ?? "baseline";
  if (!VALID_VARIANTS.includes(variantParam)) {
    return NextResponse.json(
      { error: `Invalid variant "${variantParam}". Valid: ${VALID_VARIANTS.join(", ")}` },
      { status: 400 }
    );
  }
  const variantConfig = VARIANT_CONFIGS[variantParam];
  const cooldownMs = variantConfig.cooldown_hours * 60 * 60 * 1000;

  const maxPerCallParam = request.nextUrl.searchParams.get("max_per_call");
  const maxPerCall = maxPerCallParam ? parseInt(maxPerCallParam, 10) : 2;

  // Check which symbols have cache (quick count query per symbol)
  const cacheStatus: Record<string, boolean> = {};
  for (const sym of symbols) {
    const { count } = await supabase
      .from("candle_cache")
      .select("id", { count: "exact", head: true })
      .eq("symbol", sym)
      .eq("interval", "60");
    cacheStatus[sym] = (count ?? 0) > 100;
  }

  const cachedSymbols = symbols.filter((s) => cacheStatus[s]);
  const coldSymbols = symbols.filter((s) => !cacheStatus[s]);

  // Limit cold symbols to max_per_call to avoid timeouts
  const coldToProcess = coldSymbols.slice(0, maxPerCall);
  const coldSkipped = coldSymbols.slice(maxPerCall);
  const symbolsToProcess = [...cachedSymbols, ...coldToProcess];

  if (coldSkipped.length > 0) {
    console.log(`[backtest/batch] Limiting cold symbols: processing ${coldToProcess.length}, skipped ${coldSkipped.length} (use ?max_per_call= to adjust)`);
  }

  console.log(`[backtest/batch] Starting batch: ${symbolsToProcess.length} symbols (${cachedSymbols.length} cached, ${coldToProcess.length} cold) group=${runGroupId ?? "none"}`);

  const allSignals: BacktestSignal[] = [];
  const symbolErrors: { symbol: string; error: string }[] = [];
  let totalDetected = 0;
  let filteredByGateB = 0;
  let filteredByCooldown = 0;
  let signalsBeforeCooldown = 0;

  // Fetch BTC data for regime classification (paginated for 1 year)
  let btc4h: Kline[], btc1d: Kline[];
  try {
    [btc4h, btc1d] = await Promise.all([
      fetchKlinesPaginated("BTCUSDT", "240"),
      fetchKlinesPaginated("BTCUSDT", "D"),
    ]);
    console.log(`[backtest/batch] BTC data loaded: ${btc4h.length} 4H, ${btc1d.length} 1D candles`);
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch BTC data", detail: String(err) }, { status: 502 });
  }

  // Precompute BTC regime at each BTC 4H boundary (shared across all symbols)
  // Regime only changes when a new BTC 4H or 1D candle closes.
  // We compute it once per unique 4H boundary, store as sorted array of
  // {timestamp, regime} entries for O(log n) lookup per 1H bar.
  const btcRegimeEntries: { time: number; regime: BTCRegime }[] = [];
  {
    let last4hCount = -1;
    let last1dCount = -1;
    let lastRegime: BTCRegime = "sideways";

    // Walk through all BTC 4H candle boundaries
    for (let j = 0; j < btc4h.length; j++) {
      const boundaryTime = btc4h[j].startTime;

      // Count 1D candles available at this 4H boundary
      let btc1dCount = 0;
      for (let k = btc1d.length - 1; k >= 0; k--) {
        if (btc1d[k].startTime <= boundaryTime) { btc1dCount = k + 1; break; }
      }

      const btc4hCount = j + 1;
      if (btc4hCount !== last4hCount || btc1dCount !== last1dCount) {
        last4hCount = btc4hCount;
        last1dCount = btc1dCount;

        if (btc4hCount >= 14 && btc1dCount >= 14) {
          const btc4hSlice = btc4h.slice(Math.max(0, btc4hCount - BTC_4H_WINDOW), btc4hCount);
          const btc1dSlice = btc1d.slice(Math.max(0, btc1dCount - BTC_1D_WINDOW), btc1dCount);
          lastRegime = classifyRegimeFromCandles(btc4hSlice, btc1dSlice).btc_regime;
        }
      }

      btcRegimeEntries.push({ time: boundaryTime, regime: lastRegime });
    }
  }
  console.log(`[backtest/batch] BTC regime precomputed: ${btcRegimeEntries.length} entries`);

  // Process each symbol
  let symbolsDone = 0;
  await runWithConcurrency(symbolsToProcess, MAX_CONCURRENT, async (symbol) => {
    let candles1h: Kline[], candles4h: Kline[], candles1d: Kline[];
    try {
      [candles1h, candles4h, candles1d] = await Promise.all([
        fetchKlinesPaginated(symbol, "60"),
        fetchKlinesPaginated(symbol, "240"),
        fetchKlinesPaginated(symbol, "D"),
      ]);
    } catch (err) {
      symbolErrors.push({ symbol, error: String(err) });
      symbolsDone++;
      console.log(`[backtest/batch] symbol ${symbolsDone}/${symbolsToProcess.length} ${symbol} ERROR`);
      return;
    }

    if (candles1h.length < WARMUP_BARS + FORWARD_BARS) {
      symbolsDone++;
      console.log(`[backtest/batch] symbol ${symbolsDone}/${symbolsToProcess.length} ${symbol} skipped (insufficient data)`);
      return;
    }

    // Precompute all indicators in one O(n) pass
    const indicatorFrame = precomputeIndicatorFrame(candles1h, candles4h, candles1d);

    // Precompute 4H trend frame for this symbol (one pass over 4H candles)
    const trend4hFrame = precompute4hTrendFrame(candles4h, candles1h);

    // Cooldown state: maps "SYMBOL:SETUP_TYPE" → timestamp when cooldown expires
    // Mirrors live Redis key "cooldown:{symbol}:{alertType}" with 8h TTL
    const cooldownUntil = new Map<string, number>();

    for (let i = WARMUP_BARS; i < candles1h.length - FORWARD_BARS; i++) {
      const currentBarTime = candles1h[i].startTime;

      // Read precomputed indicators for this bar (O(1) lookup)
      const indicators = indicatorFrame[i];
      if (!indicators) continue;

      const signals = detectSignals(symbol, indicators);
      if (signals.length === 0) continue;

      // BTC regime: O(1) lookup from precomputed frame (binary search)
      let regime: BTCRegime = "sideways";
      {
        // Find the latest BTC 4H entry at or before currentBarTime
        let lo = 0, hi = btcRegimeEntries.length - 1, best = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (btcRegimeEntries[mid].time <= currentBarTime) {
            best = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (best >= 0) regime = btcRegimeEntries[best].regime;
      }

      // 4H trend: O(1) lookup from precomputed frame
      const trend4h = trend4hFrame[i];
      const futureBars = candles1h.slice(i + 1, i + 1 + FORWARD_BARS);

      for (const sig of signals) {
        totalDetected++;
        const isLong = sig.type.includes("LONG");
        const rawEntry = indicators.close;
        const atrVal = indicators.atr_1h;

        const gateB = runGateB({
          alertType: sig.type,
          trend4h: trend4h.trend,
          btcRegime: regime,
          atr1h: atrVal,
          markPrice: rawEntry,
          rrTp1: 1.5,
          rsi: indicators.rsi,
          adx1h: indicators.adx_1h,
          volume: indicators.volume,
          sma20Volume: indicators.sma20_volume,
        }, {
          allow_counter_trend: variantConfig.allow_counter_trend,
          sideways_sq_volume_mult: variantConfig.sideways_sq_volume_mult,
        });

        if (!gateB.passed) {
          filteredByGateB++;
          continue;
        }

        // Cooldown check: mirrors live pipeline.ts:295-303
        // Live uses Redis key "cooldown:{symbol}:{alertType}" with 8h TTL
        // Here we track expiry timestamp per (symbol, setup_type)
        const cooldownKey = `${symbol}:${sig.type}`;
        const expiresAt = cooldownUntil.get(cooldownKey);
        signalsBeforeCooldown++;
        if (expiresAt !== undefined && currentBarTime < expiresAt) {
          filteredByCooldown++;
          continue;
        }

        // Signal accepted — set cooldown (mirrors live pipeline.ts:397-398)
        // Live sets cooldown only when final decision is LONG or SHORT
        // In backtest, passing Gate B = trade decision (no Claude override)
        cooldownUntil.set(cooldownKey, currentBarTime + cooldownMs);

        const grade = gradeSignalLib(rawEntry, atrVal, isLong, futureBars);

        // Deterministic reviewer shadow classification (analytics only)
        const shadowResult = classifyReviewerShadow({
          setup_type: sig.type,
          regime,
          trend4h: trend4h.trend,
          rsi: indicators.rsi,
          adx_1h: indicators.adx_1h,
          volume: indicators.volume,
          sma20_volume: indicators.sma20_volume,
          z_score: indicators.z_score,
          bb_width_ratio: indicators.bb_width_ratio,
        });

        allSignals.push({
          symbol,
          setup_type: sig.type,
          candle_time: new Date(currentBarTime).toISOString(),
          entry_price: grade.entry_price,
          stop_loss: grade.stop_loss,
          tp1: grade.tp1,
          tp2: grade.tp2,
          tp3: grade.tp3,
          hit_tp1: grade.hit_tp1,
          hit_tp2: grade.hit_tp2,
          hit_tp3: grade.hit_tp3,
          hit_sl: grade.hit_sl,
          bars_to_resolution: grade.bars_to_resolution,
          max_favorable: grade.max_favorable,
          max_adverse: grade.max_adverse,
          regime,
          atr: atrVal,
          reviewer_shadow: shadowResult.shadow,
          reviewer_shadow_action: shadowResult.action,
          is_disabled_setup: STRATEGY_PROFILE.disabled_setups.includes(sig.type as typeof STRATEGY_PROFILE.disabled_setups[number]),
        });
      }
    }

    symbolsDone++;
    console.log(`[backtest/batch] symbol ${symbolsDone}/${symbolsToProcess.length} ${symbol} complete (${allSignals.length} signals so far)`);
  });

  // Separate enabled (live-equivalent) from disabled (research-only) signals
  // Policy source: STRATEGY_PROFILE.disabled_setups in src/lib/reviewer.ts
  const liveSignals = allSignals.filter((s) => !s.is_disabled_setup);
  const disabledSignals = allSignals.filter((s) => s.is_disabled_setup);

  // Calculate live-equivalent statistics (enabled setups only)
  const total = liveSignals.length;
  const wins = liveSignals.filter((s) => s.hit_tp1).length;
  const rValues = liveSignals.map(computeRBacktest);
  const avgR = total > 0 ? rValues.reduce((a, b) => a + b, 0) / total : 0;
  const grossProfit = rValues.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rValues.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const candleTimes = allSignals.map((s) => new Date(s.candle_time).getTime());
  const earliestMs = candleTimes.length > 0 ? Math.min(...candleTimes) : 0;
  const latestMs = candleTimes.length > 0 ? Math.max(...candleTimes) : 0;
  const tradingDays = candleTimes.length > 0 ? Math.round((latestMs - earliestMs) / (1000 * 60 * 60 * 24)) : 0;

  // Shadow aggregation (live-equivalent signals only)
  const shadowCounts: Record<string, number> = {};
  const actionCounts: Record<string, number> = {};
  for (const s of liveSignals) {
    shadowCounts[s.reviewer_shadow] = (shadowCounts[s.reviewer_shadow] || 0) + 1;
    actionCounts[s.reviewer_shadow_action] = (actionCounts[s.reviewer_shadow_action] || 0) + 1;
  }

  // Disabled setup counts for research_context
  const disabledBySetup: Record<string, number> = {};
  for (const s of disabledSignals) {
    disabledBySetup[s.setup_type] = (disabledBySetup[s.setup_type] || 0) + 1;
  }

  const batchSummary = {
    variant: variantParam,
    variant_config: variantConfig,
    batch_symbols: symbolsToProcess,
    symbols_tested: symbolsToProcess.length,
    symbols_skipped: coldSkipped.length > 0 ? coldSkipped : undefined,
    backtest_period: {
      from: earliestMs > 0 ? new Date(earliestMs).toISOString() : null,
      to: latestMs > 0 ? new Date(latestMs).toISOString() : null,
      trading_days: tradingDays,
    },

    // ── Live-equivalent results ─────────────────────────
    // Signals that passed: detection → Gate B → cooldown
    // AND are from enabled setups per STRATEGY_PROFILE.
    // This is what production would actually consider trading.
    live_equivalent: {
      enabled_setups: [STRATEGY_PROFILE.primary_setup, STRATEGY_PROFILE.secondary_setup],
      total_signals: total,
      win_rate_tp1: total > 0 ? round(wins / total, 4) : 0,
      profit_factor: round(profitFactor, 2),
      avg_r: round(avgR, 2),
    },

    // ── Reviewer shadow (NOT Claude parity) ─────────────
    // Deterministic confidence classification of live-equivalent signals only
    reviewer_shadow: {
      note: "Deterministic approximation only. Not Claude parity.",
      by_confidence: shadowCounts,
      by_action: actionCounts,
    },

    // ── Research context ────────────────────────────────
    // Full funnel showing how each filter stage reduces signals.
    // Disabled setups are graded but excluded from live_equivalent.
    research_context: {
      total_detected: totalDetected,
      filtered_by_gate_b: filteredByGateB,
      passed_gate_b: signalsBeforeCooldown,
      filtered_by_cooldown: filteredByCooldown,
      passed_to_grading: allSignals.length,
      disabled_setups: disabledSignals.length > 0 ? {
        policy_source: "STRATEGY_PROFILE.disabled_setups",
        disabled_list: Array.from(STRATEGY_PROFILE.disabled_setups),
        total_excluded: disabledSignals.length,
        by_setup: disabledBySetup,
      } : undefined,
      live_equivalent_count: total,
    },

    symbol_errors: symbolErrors,
    runtime_ms: Date.now() - startTime,
  };

  // Store batch results in Supabase
  const { data: runRow } = await supabase
    .from("backtest_runs")
    .insert({
      symbols_tested: symbolsToProcess.length,
      total_signals: total,
      results: allSignals,
      summary: batchSummary,
      run_group_id: runGroupId,
      variant: variantParam,
    })
    .select("id")
    .maybeSingle();

  const runId = runRow?.id ?? null;

  if (runId && allSignals.length > 0) {
    for (let i = 0; i < allSignals.length; i += 100) {
      const batch = allSignals.slice(i, i + 100).map((s) => ({
        backtest_run_id: runId,
        symbol: s.symbol,
        setup_type: s.setup_type,
        candle_time: s.candle_time,
        entry_price: s.entry_price,
        stop_loss: s.stop_loss,
        tp1: s.tp1,
        tp2: s.tp2,
        tp3: s.tp3,
        hit_tp1: s.hit_tp1,
        hit_tp2: s.hit_tp2,
        hit_tp3: s.hit_tp3,
        hit_sl: s.hit_sl,
        bars_to_resolution: s.bars_to_resolution,
        max_favorable: s.max_favorable,
        max_adverse: s.max_adverse,
        regime: s.regime,
        atr: s.atr,
        reviewer_shadow: s.reviewer_shadow,
        reviewer_shadow_action: s.reviewer_shadow_action,
        run_group_id: runGroupId,
      }));
      await supabase.from("backtest_signals").insert(batch);
    }
  }

  console.log(`[backtest/batch] Complete: ${symbols.join(",")} → ${total} signals, run_id=${runId}, group=${runGroupId}`);
  return NextResponse.json({ run_id: runId, run_group_id: runGroupId, ...batchSummary });
}
