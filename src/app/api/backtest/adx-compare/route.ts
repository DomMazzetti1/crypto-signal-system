import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";
import {
  computeIndicators,
  detectSignalsWithParams,
  SymbolIndicators,
  SignalParams,
  DEFAULT_SIGNAL_PARAMS,
} from "@/lib/signals";
import { gradeSignal, computeR, GradeResult } from "@/lib/grade-signal";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ── Constants (match existing backtest) ──────────────────

const WARMUP_BARS = 150;
const FORWARD_BARS = 48;
const MAX_CONCURRENT = 4;
const BYBIT_BATCH = 1000;
const CACHE_FRESH_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

const TARGET_CANDLES: Record<string, number> = {
  "60": 8760,
  "240": 2190,
  "D": 400,
};

// ── Types ────────────────────────────────────────────────

interface VariantResult {
  label: string;
  params: SignalParams;
  total_signals: number;
  filled: number;
  not_filled: number;
  tp1_hits: number;
  tp2_hits: number;
  tp3_hits: number;
  sl_hits: number;
  win_rate_tp1: number;
  win_rate_tp2: number;
  win_rate_tp3: number;
  avg_r_multiple: number;
  by_setup: Record<string, { count: number; win_rate: number; avg_r: number }>;
  notes: string[];
}

interface GradedSignal {
  symbol: string;
  setup_type: string;
  candle_time: number;
  grade: GradeResult;
}

// ── Helpers ──────────────────────────────────────────────

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

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

// ── Cache-aware candle fetch (matches batch/route.ts pattern) ─

async function readCache(symbol: string, interval: string): Promise<Kline[]> {
  const supabase = getSupabase();
  const rows: Kline[] = [];
  let offset = 0;
  const PAGE = 1000;

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

async function writeCache(symbol: string, interval: string, candles: Kline[]): Promise<void> {
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

async function fetchFromBybit(symbol: string, interval: string, target: number, endParam?: number): Promise<Kline[]> {
  const allCandles: Map<number, Kline> = new Map();
  let end = endParam;

  while (allCandles.size < target) {
    const batchSize = Math.min(BYBIT_BATCH, target - allCandles.size);
    let url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${batchSize}`;
    if (end !== undefined) url += `&end=${end}`;

    let data: { retCode: number; retMsg: string; result: { list: string[][] } };
    try {
      const res = await fetch(url, { cache: "no-store" });
      data = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(url, { cache: "no-store" });
      data = await res.json();
    }

    if (data.retCode !== 0) throw new Error(`Kline fetch failed: ${symbol} ${interval}: ${data.retMsg}`);

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

async function fetchKlinesPaginated(symbol: string, interval: string, target?: number, cacheOnly?: boolean): Promise<Kline[]> {
  const totalNeeded = target ?? TARGET_CANDLES[interval] ?? 1000;

  // 1. Read cache
  const cached = await readCache(symbol, interval);

  // Cache-only mode: return whatever we have, no Bybit calls
  if (cacheOnly) {
    if (cached.length === 0) {
      throw new Error(`Cache empty for ${symbol}/${interval} — run /api/backtest/warmup?symbol=${symbol} first`);
    }
    return cached;
  }

  const now = Date.now();
  const freshBoundary = now - CACHE_FRESH_MS;
  const stableCandles = cached.filter((c) => c.startTime < freshBoundary);
  const staleCount = cached.length - stableCandles.length;

  let freshCandles: Kline[] = [];

  if (stableCandles.length >= totalNeeded) {
    // Cache covers the window — only refresh stale recent candles
    if (staleCount > 0) {
      freshCandles = await fetchFromBybit(symbol, interval, staleCount + 10);
      await writeCache(symbol, interval, freshCandles);
    }
  } else if (stableCandles.length > 0) {
    // Partial cache — fetch gap + recent
    const oldestCached = stableCandles[0].startTime;
    const missingCount = totalNeeded - stableCandles.length;
    const olderCandles = await fetchFromBybit(symbol, interval, missingCount, oldestCached - 1);
    const recentCandles = await fetchFromBybit(symbol, interval, Math.max(staleCount + 50, 100));
    freshCandles = [...olderCandles, ...recentCandles];
    await writeCache(symbol, interval, freshCandles);
  } else {
    // Cold start — full fetch
    freshCandles = await fetchFromBybit(symbol, interval, totalNeeded);
    await writeCache(symbol, interval, freshCandles);
  }

  // Merge + deduplicate
  const merged = new Map<number, Kline>();
  for (const c of stableCandles) merged.set(c.startTime, c);
  for (const c of freshCandles) merged.set(c.startTime, c);
  return Array.from(merged.values()).sort((a, b) => a.startTime - b.startTime);
}

function candlesUpTo(candles: Kline[], beforeMs: number): Kline[] {
  return candles.filter((c) => c.startTime < beforeMs);
}

// ── Precomputed bar frame (indicators + future bars per step) ─

interface BarFrame {
  barTime: number;
  indicators: SymbolIndicators;
  futureBars: Kline[];
}

function precomputeBarFrames(
  c1h: Kline[],
  c4h: Kline[],
  c1d: Kline[]
): BarFrame[] {
  const frames: BarFrame[] = [];
  if (c1h.length < WARMUP_BARS + FORWARD_BARS) return frames;

  for (let i = WARMUP_BARS; i < c1h.length - FORWARD_BARS; i++) {
    const slice1h = c1h.slice(0, i + 1);
    const currentBarTime = c1h[i].startTime;
    const slice4h = candlesUpTo(c4h, currentBarTime + 1);
    const slice1d = candlesUpTo(c1d, currentBarTime + 1);

    if (slice4h.length < 14 || slice1d.length < 14) continue;

    const indicators = computeIndicators(slice1h, slice4h, slice1d);
    if (!indicators) continue;

    frames.push({
      barTime: currentBarTime,
      indicators,
      futureBars: c1h.slice(i + 1, i + 1 + FORWARD_BARS),
    });
  }

  return frames;
}

// ── Run one variant against precomputed frames ───────────

function runVariant(
  label: string,
  params: SignalParams,
  precomputed: Map<string, BarFrame[]>
): VariantResult {
  const signals: GradedSignal[] = [];
  const notes: string[] = [];

  for (const [symbol, frames] of Array.from(precomputed.entries())) {
    for (const frame of frames) {
      const detected = detectSignalsWithParams(symbol, frame.indicators, params);
      if (detected.length === 0) continue;

      for (const sig of detected) {
        const isLong = sig.type.includes("LONG");
        const grade = gradeSignal(frame.indicators.close, frame.indicators.atr_1h, isLong, frame.futureBars);
        signals.push({ symbol, setup_type: sig.type, candle_time: frame.barTime, grade });
      }
    }
  }

  // Aggregate
  const total = signals.length;
  const tp1Hits = signals.filter((s) => s.grade.hit_tp1).length;
  const tp2Hits = signals.filter((s) => s.grade.hit_tp2).length;
  const tp3Hits = signals.filter((s) => s.grade.hit_tp3).length;
  const slHits = signals.filter((s) => s.grade.hit_sl && !s.grade.hit_tp1).length;
  const rValues = signals.map((s) => computeR(s.grade));
  const avgR = total > 0 ? rValues.reduce((a, b) => a + b, 0) / total : 0;

  // By setup
  const setupTypes = ["MR_LONG", "MR_SHORT", "SQ_SHORT"];
  const bySetup: Record<string, { count: number; win_rate: number; avg_r: number }> = {};
  for (const st of setupTypes) {
    const subset = signals.filter((s) => s.setup_type === st);
    const subRs = subset.map((s) => computeR(s.grade));
    bySetup[st] = {
      count: subset.length,
      win_rate: subset.length > 0 ? round(subset.filter((s) => s.grade.hit_tp1).length / subset.length, 4) : 0,
      avg_r: subset.length > 0 ? round(subRs.reduce((a, b) => a + b, 0) / subset.length, 2) : 0,
    };
  }

  if (total === 0) notes.push("No signals detected with these params");

  return {
    label,
    params,
    total_signals: total,
    filled: total, // all signals are "filled" at close in backtest
    not_filled: 0,
    tp1_hits: tp1Hits,
    tp2_hits: tp2Hits,
    tp3_hits: tp3Hits,
    sl_hits: slHits,
    win_rate_tp1: total > 0 ? round(tp1Hits / total, 4) : 0,
    win_rate_tp2: total > 0 ? round(tp2Hits / total, 4) : 0,
    win_rate_tp3: total > 0 ? round(tp3Hits / total, 4) : 0,
    avg_r_multiple: round(avgR, 2),
    by_setup: bySetup,
    notes,
  };
}

// ── ADX sensitivity matrix ───────────────────────────────

const ADX_MATRIX: { label: string; params: SignalParams }[] = [
  { label: "baseline (18/22)", params: { mr_adx_1h_max: 18, mr_adx_4h_max: 22 } },
  { label: "v1 (20/22)",       params: { mr_adx_1h_max: 20, mr_adx_4h_max: 22 } },
  { label: "v2 (22/22)",       params: { mr_adx_1h_max: 22, mr_adx_4h_max: 22 } },
  { label: "v3 (18/24)",       params: { mr_adx_1h_max: 18, mr_adx_4h_max: 24 } },
  { label: "v4 (18/26)",       params: { mr_adx_1h_max: 18, mr_adx_4h_max: 26 } },
  { label: "v5 (20/24)",       params: { mr_adx_1h_max: 20, mr_adx_4h_max: 24 } },
];

interface VariantDelta {
  signal_count_delta: number;
  win_rate_tp1_delta: number;
  avg_r_delta: number;
  mr_long_count_delta: number;
  mr_short_count_delta: number;
}

interface RankedVariant {
  rank: number;
  label: string;
  params: SignalParams;
  total_signals: number;
  mr_long: number;
  mr_short: number;
  sq_short: number;
  win_rate_tp1: number;
  avg_r_multiple: number;
  delta_vs_baseline: VariantDelta;
}

// ── Shared data fetcher + precompute ─────────────────────

async function fetchAndPrecompute(
  symbols: string[],
  cacheOnly?: boolean
): Promise<{ precomputed: Map<string, BarFrame[]>; errors: string[] }> {
  const precomputed = new Map<string, BarFrame[]>();
  const errors: string[] = [];
  let fetched = 0;

  await runWithConcurrency(symbols, MAX_CONCURRENT, async (symbol) => {
    try {
      const [c1h, c4h, c1d] = await Promise.all([
        fetchKlinesPaginated(symbol, "60", undefined, cacheOnly),
        fetchKlinesPaginated(symbol, "240", undefined, cacheOnly),
        fetchKlinesPaginated(symbol, "D", undefined, cacheOnly),
      ]);

      const frames = precomputeBarFrames(c1h, c4h, c1d);
      precomputed.set(symbol, frames);
    } catch (err) {
      errors.push(`${symbol}: ${String(err).slice(0, 80)}`);
    }
    fetched++;
    if (fetched % 5 === 0) {
      console.log(`[adx-compare] Fetched+precomputed ${fetched}/${symbols.length}`);
    }
  });

  return { precomputed, errors };
}

async function resolveSymbols(body: { symbols?: string[] }): Promise<string[] | NextResponse> {
  if (body.symbols && body.symbols.length > 0) return body.symbols;
  const supabase = getSupabase();
  const { data: rows, error } = await supabase
    .from("universe")
    .select("symbol")
    .eq("is_eligible", true)
    .order("symbol");
  if (error || !rows) {
    return NextResponse.json({ error: "Failed to read universe" }, { status: 500 });
  }
  return rows.map((r) => r.symbol);
}

// ── Main handler ─────────────────────────────────────────

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  let body: {
    mode?: "compare" | "matrix";
    symbols?: string[];
    baseline?: SignalParams;
    relaxed?: SignalParams;
    cache_only?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const resolved = await resolveSymbols(body);
  if (resolved instanceof NextResponse) return resolved;
  const symbols = resolved;

  const cacheOnly = body.cache_only ?? false;

  // Route to matrix mode
  if (body.mode === "matrix") {
    return runMatrix(symbols, startTime, cacheOnly);
  }

  // Default: two-variant compare (existing behavior)
  const baselineParams = body.baseline ?? DEFAULT_SIGNAL_PARAMS;
  const relaxedParams = body.relaxed ?? { mr_adx_1h_max: 25, mr_adx_4h_max: 30 };

  console.log(`[adx-compare] Starting: ${symbols.length} symbols, cache_only=${cacheOnly}, baseline=${JSON.stringify(baselineParams)}, relaxed=${JSON.stringify(relaxedParams)}`);

  const { precomputed, errors } = await fetchAndPrecompute(symbols, cacheOnly);
  const totalFrames = Array.from(precomputed.values()).reduce((s, f) => s + f.length, 0);

  console.log(`[adx-compare] Data fetched: ${precomputed.size} symbols, ${totalFrames} bar frames precomputed, ${errors.length} errors. Running variants...`);

  const baseline = runVariant("baseline", baselineParams, precomputed);
  const relaxed = runVariant("relaxed", relaxedParams, precomputed);

  const delta = {
    signal_count: `${baseline.total_signals} → ${relaxed.total_signals} (${relaxed.total_signals > baseline.total_signals ? "+" : ""}${relaxed.total_signals - baseline.total_signals})`,
    win_rate_tp1: `${baseline.win_rate_tp1} → ${relaxed.win_rate_tp1} (${round(relaxed.win_rate_tp1 - baseline.win_rate_tp1, 4) > 0 ? "+" : ""}${round(relaxed.win_rate_tp1 - baseline.win_rate_tp1, 4)})`,
    avg_r: `${baseline.avg_r_multiple} → ${relaxed.avg_r_multiple} (${round(relaxed.avg_r_multiple - baseline.avg_r_multiple, 2) > 0 ? "+" : ""}${round(relaxed.avg_r_multiple - baseline.avg_r_multiple, 2)})`,
    by_setup: {} as Record<string, { count_delta: string; win_rate_delta: string; avg_r_delta: string }>,
  };

  for (const st of ["MR_LONG", "MR_SHORT", "SQ_SHORT"]) {
    const b = baseline.by_setup[st] ?? { count: 0, win_rate: 0, avg_r: 0 };
    const r = relaxed.by_setup[st] ?? { count: 0, win_rate: 0, avg_r: 0 };
    delta.by_setup[st] = {
      count_delta: `${b.count} → ${r.count}`,
      win_rate_delta: `${b.win_rate} → ${r.win_rate}`,
      avg_r_delta: `${b.avg_r} → ${r.avg_r}`,
    };
  }

  const runtimeMs = Date.now() - startTime;

  return NextResponse.json({
    mode: "compare",
    symbols_tested: precomputed.size,
    fetch_errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    runtime_ms: runtimeMs,
    baseline,
    relaxed,
    delta,
    note: runtimeMs > 250000 ? "Approaching Vercel timeout. Consider fewer symbols or running locally." : undefined,
  });
}

// ── Matrix mode ──────────────────────────────────────────

async function runMatrix(symbols: string[], startTime: number, cacheOnly?: boolean): Promise<NextResponse> {
  console.log(`[adx-matrix] Starting: ${symbols.length} symbols, ${ADX_MATRIX.length} variants, cache_only=${!!cacheOnly}`);

  const { precomputed, errors } = await fetchAndPrecompute(symbols, cacheOnly);
  const totalFrames = Array.from(precomputed.values()).reduce((s, f) => s + f.length, 0);

  console.log(`[adx-matrix] Data fetched: ${precomputed.size} symbols, ${totalFrames} bar frames precomputed, ${errors.length} errors. Running ${ADX_MATRIX.length} variants...`);

  // Run all variants against precomputed indicators (no recomputation)
  const results: VariantResult[] = [];
  for (const { label, params } of ADX_MATRIX) {
    const variantStart = Date.now();
    const result = runVariant(label, params, precomputed);
    console.log(`[adx-matrix] ${label}: ${result.total_signals} signals, ${Date.now() - variantStart}ms`);
    results.push(result);
  }

  const baselineResult = results[0];

  // Build ranked table with deltas
  const ranked: RankedVariant[] = results.map((r) => {
    const mrLong = r.by_setup["MR_LONG"]?.count ?? 0;
    const mrShort = r.by_setup["MR_SHORT"]?.count ?? 0;
    const sqShort = r.by_setup["SQ_SHORT"]?.count ?? 0;
    const bMrLong = baselineResult.by_setup["MR_LONG"]?.count ?? 0;
    const bMrShort = baselineResult.by_setup["MR_SHORT"]?.count ?? 0;

    return {
      rank: 0, // set below
      label: r.label,
      params: r.params,
      total_signals: r.total_signals,
      mr_long: mrLong,
      mr_short: mrShort,
      sq_short: sqShort,
      win_rate_tp1: r.win_rate_tp1,
      avg_r_multiple: r.avg_r_multiple,
      delta_vs_baseline: {
        signal_count_delta: r.total_signals - baselineResult.total_signals,
        win_rate_tp1_delta: round(r.win_rate_tp1 - baselineResult.win_rate_tp1, 4),
        avg_r_delta: round(r.avg_r_multiple - baselineResult.avg_r_multiple, 2),
        mr_long_count_delta: mrLong - bMrLong,
        mr_short_count_delta: mrShort - bMrShort,
      },
    };
  });

  // Rank: first by avg_r preservation (higher is better), then by signal count increase
  ranked.sort((a, b) => {
    // Primary: avg_r (descending — higher/less negative is better)
    if (a.avg_r_multiple !== b.avg_r_multiple) return b.avg_r_multiple - a.avg_r_multiple;
    // Secondary: signal count (descending — more signals is better)
    return b.total_signals - a.total_signals;
  });
  ranked.forEach((r, i) => (r.rank = i + 1));

  // SQ_SHORT should be identical across variants (ADX params don't affect it)
  const sqConsistent = results.every(
    (r) => (r.by_setup["SQ_SHORT"]?.count ?? 0) === (baselineResult.by_setup["SQ_SHORT"]?.count ?? 0)
  );

  const runtimeMs = Date.now() - startTime;

  return NextResponse.json({
    mode: "matrix",
    symbols_tested: precomputed.size,
    fetch_errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    runtime_ms: runtimeMs,
    variants_tested: ADX_MATRIX.length,
    sq_short_unchanged: sqConsistent,
    ranking: ranked,
    full_results: results,
    note: runtimeMs > 250000 ? "Approaching Vercel timeout. Consider fewer symbols or running locally." : undefined,
  });
}
