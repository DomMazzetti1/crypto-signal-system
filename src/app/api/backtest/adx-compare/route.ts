import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";
import {
  computeIndicators,
  detectSignalsWithParams,
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

async function fetchKlinesPaginated(
  symbol: string,
  interval: string,
  target?: number
): Promise<Kline[]> {
  const totalNeeded = target ?? TARGET_CANDLES[interval] ?? 1000;
  const allCandles: Map<number, Kline> = new Map();
  let endParam: number | undefined = undefined;

  while (allCandles.size < totalNeeded) {
    const batchSize = Math.min(BYBIT_BATCH, totalNeeded - allCandles.size);
    let url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${batchSize}`;
    if (endParam !== undefined) url += `&end=${endParam}`;

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
    if (endParam !== undefined && earliestTime >= endParam) break;
    endParam = earliestTime - 1;
  }

  return Array.from(allCandles.values()).sort((a, b) => a.startTime - b.startTime);
}

function candlesUpTo(candles: Kline[], beforeMs: number): Kline[] {
  return candles.filter((c) => c.startTime < beforeMs);
}

// ── Run one variant ──────────────────────────────────────

function runVariant(
  label: string,
  params: SignalParams,
  symbolData: Map<string, { c1h: Kline[]; c4h: Kline[]; c1d: Kline[] }>
): VariantResult {
  const signals: GradedSignal[] = [];
  const notes: string[] = [];

  for (const [symbol, { c1h, c4h, c1d }] of Array.from(symbolData.entries())) {
    if (c1h.length < WARMUP_BARS + FORWARD_BARS) continue;

    for (let i = WARMUP_BARS; i < c1h.length - FORWARD_BARS; i++) {
      const slice1h = c1h.slice(0, i + 1);
      const currentBarTime = c1h[i].startTime;
      const slice4h = candlesUpTo(c4h, currentBarTime + 1);
      const slice1d = candlesUpTo(c1d, currentBarTime + 1);

      if (slice4h.length < 14 || slice1d.length < 14) continue;

      const indicators = computeIndicators(slice1h, slice4h, slice1d);
      if (!indicators) continue;

      const detected = detectSignalsWithParams(symbol, indicators, params);
      if (detected.length === 0) continue;

      const futureBars = c1h.slice(i + 1, i + 1 + FORWARD_BARS);

      for (const sig of detected) {
        const isLong = sig.type.includes("LONG");
        const grade = gradeSignal(indicators.close, indicators.atr_1h, isLong, futureBars);
        signals.push({ symbol, setup_type: sig.type, candle_time: currentBarTime, grade });
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

// ── Main handler ─────────────────────────────────────────

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  let body: {
    symbols?: string[];
    baseline?: SignalParams;
    relaxed?: SignalParams;
  };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const supabase = getSupabase();

  // Resolve symbols
  let symbols: string[];
  if (body.symbols && body.symbols.length > 0) {
    symbols = body.symbols;
  } else {
    const { data: rows, error } = await supabase
      .from("universe")
      .select("symbol")
      .eq("is_eligible", true)
      .order("symbol");
    if (error || !rows) {
      return NextResponse.json({ error: "Failed to read universe" }, { status: 500 });
    }
    symbols = rows.map((r) => r.symbol);
  }

  const baselineParams = body.baseline ?? DEFAULT_SIGNAL_PARAMS;
  const relaxedParams = body.relaxed ?? { mr_adx_1h_max: 25, mr_adx_4h_max: 30 };

  console.log(`[adx-compare] Starting: ${symbols.length} symbols, baseline=${JSON.stringify(baselineParams)}, relaxed=${JSON.stringify(relaxedParams)}`);

  // Fetch all data once (shared between variants)
  const symbolData = new Map<string, { c1h: Kline[]; c4h: Kline[]; c1d: Kline[] }>();
  const errors: string[] = [];
  let fetched = 0;

  await runWithConcurrency(symbols, MAX_CONCURRENT, async (symbol) => {
    try {
      const [c1h, c4h, c1d] = await Promise.all([
        fetchKlinesPaginated(symbol, "60"),
        fetchKlinesPaginated(symbol, "240"),
        fetchKlinesPaginated(symbol, "D"),
      ]);
      symbolData.set(symbol, { c1h, c4h, c1d });
    } catch (err) {
      errors.push(`${symbol}: ${String(err).slice(0, 80)}`);
    }
    fetched++;
    if (fetched % 5 === 0) {
      console.log(`[adx-compare] Fetched ${fetched}/${symbols.length}`);
    }
  });

  console.log(`[adx-compare] Data fetched: ${symbolData.size} symbols, ${errors.length} errors. Running variants...`);

  // Run both variants on the same data
  const baseline = runVariant("baseline", baselineParams, symbolData);
  const relaxed = runVariant("relaxed", relaxedParams, symbolData);

  // Compute deltas
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
    symbols_tested: symbolData.size,
    fetch_errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    runtime_ms: runtimeMs,
    baseline,
    relaxed,
    delta,
    note: runtimeMs > 250000 ? "Approaching Vercel timeout. Consider fewer symbols or running locally." : undefined,
  });
}
