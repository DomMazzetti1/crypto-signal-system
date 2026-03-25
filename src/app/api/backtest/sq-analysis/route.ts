import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";
import { computeIndicators, detectSignals } from "@/lib/signals";
import { gradeSignal, computeR, GradeResult } from "@/lib/grade-signal";
import { runWithConcurrency, readCache, enforceProductionLimits, round } from "@/lib/backtest-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WARMUP_BARS = 150;
const FORWARD_BARS = 48;
const MAX_CONCURRENT = 4;

// ── Types ────────────────────────────────────────────────

interface SQSignal {
  symbol: string;
  candle_time: number;
  grade: GradeResult;
  // Indicator context at signal time
  bb_width_ratio: number;
  adx_1h: number;
  rsi: number;
  z_score: number;
  volume_sma_ratio: number;
  close_off_high: number;
  close_4h_vs_ema50_4h_pct: number;
  candle_range_vs_atr: number;
  close_vs_ema20_pct: number;
}

interface BucketStats {
  label: string;
  count: number;
  win_rate_tp1: number;
  win_rate_tp2: number;
  avg_r: number;
  avg_bb_width: number;
  avg_adx: number;
  avg_rsi: number;
}

// ── Helpers ──────────────────────────────────────────────

function candlesUpTo(candles: Kline[], beforeMs: number): Kline[] {
  return candles.filter((c) => c.startTime < beforeMs);
}

function bucketize(signals: SQSignal[], key: (s: SQSignal) => string): Map<string, SQSignal[]> {
  const map = new Map<string, SQSignal[]>();
  for (const s of signals) {
    const k = key(s);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(s);
  }
  return map;
}

function computeBucketStats(label: string, signals: SQSignal[]): BucketStats {
  const n = signals.length;
  if (n === 0) return { label, count: 0, win_rate_tp1: 0, win_rate_tp2: 0, avg_r: 0, avg_bb_width: 0, avg_adx: 0, avg_rsi: 0 };
  const tp1 = signals.filter((s) => s.grade.hit_tp1).length;
  const tp2 = signals.filter((s) => s.grade.hit_tp2).length;
  const rs = signals.map((s) => computeR(s.grade));
  return {
    label,
    count: n,
    win_rate_tp1: round(tp1 / n, 4),
    win_rate_tp2: round(tp2 / n, 4),
    avg_r: round(rs.reduce((a, b) => a + b, 0) / n, 2),
    avg_bb_width: round(signals.reduce((a, s) => a + s.bb_width_ratio, 0) / n, 4),
    avg_adx: round(signals.reduce((a, s) => a + s.adx_1h, 0) / n, 1),
    avg_rsi: round(signals.reduce((a, s) => a + s.rsi, 0) / n, 1),
  };
}

// ── Main handler ─────────────────────────────────────────

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  let body: { symbols?: string[] };
  try { body = await request.json(); } catch { body = {}; }

  const supabase = getSupabase();
  let symbols: string[];
  if (body.symbols && body.symbols.length > 0) {
    symbols = body.symbols;
  } else {
    const { data: rows, error } = await supabase
      .from("universe").select("symbol").eq("is_eligible", true).order("symbol");
    if (error || !rows) return NextResponse.json({ error: "Failed to read universe" }, { status: 500 });
    symbols = rows.map((r) => r.symbol);
  }

  // Production guardrails (this route always reads from cache)
  const guardrailErr = enforceProductionLimits(symbols, true);
  if (guardrailErr) return guardrailErr;

  const allSignals: SQSignal[] = [];
  const errors: string[] = [];
  let fetched = 0;

  await runWithConcurrency(symbols, MAX_CONCURRENT, async (symbol) => {
    try {
      const [c1h, c4h, c1d] = await Promise.all([
        readCache(symbol, "60"),
        readCache(symbol, "240"),
        readCache(symbol, "D"),
      ]);

      if (c1h.length < WARMUP_BARS + FORWARD_BARS) return;

      for (let i = WARMUP_BARS; i < c1h.length - FORWARD_BARS; i++) {
        const slice1h = c1h.slice(0, i + 1);
        const barTime = c1h[i].startTime;
        const slice4h = candlesUpTo(c4h, barTime + 1);
        const slice1d = candlesUpTo(c1d, barTime + 1);
        if (slice4h.length < 14 || slice1d.length < 14) continue;

        const ind = computeIndicators(slice1h, slice4h, slice1d);
        if (!ind) continue;

        const detected = detectSignals(symbol, ind);
        const sqSigs = detected.filter((s) => s.type === "SQ_SHORT");
        if (sqSigs.length === 0) continue;

        const futureBars = c1h.slice(i + 1, i + 1 + FORWARD_BARS);
        const grade = gradeSignal(ind.close, ind.atr_1h, false, futureBars);

        allSignals.push({
          symbol,
          candle_time: barTime,
          grade,
          bb_width_ratio: ind.bb_width_ratio,
          adx_1h: ind.adx_1h,
          rsi: ind.rsi,
          z_score: ind.z_score,
          volume_sma_ratio: ind.sma20_volume > 0 ? ind.volume / ind.sma20_volume : 0,
          close_off_high: ind.close_off_high,
          close_4h_vs_ema50_4h_pct: ind.ema50_4h !== 0 ? (ind.close_4h - ind.ema50_4h) / ind.ema50_4h * 100 : 0,
          candle_range_vs_atr: ind.atr_1h > 0 ? ind.candle_range / ind.atr_1h : 0,
          close_vs_ema20_pct: ind.ema20 !== 0 ? (ind.close - ind.ema20) / ind.ema20 * 100 : 0,
        });
      }
    } catch (err) {
      errors.push(`${symbol}: ${String(err).slice(0, 80)}`);
    }
    fetched++;
    if (fetched % 5 === 0) console.log(`[sq-analysis] ${fetched}/${symbols.length}`);
  });

  // ── Bucketing ──────────────────────────────────────────

  // 1. BB width buckets
  const bbWidthBuckets = bucketize(allSignals, (s) => {
    if (s.bb_width_ratio < 0.04) return "<0.04";
    if (s.bb_width_ratio < 0.06) return "0.04–0.06";
    if (s.bb_width_ratio < 0.08) return "0.06–0.08";
    return "≥0.08";
  });

  // 2. ADX 1H buckets
  const adxBuckets = bucketize(allSignals, (s) => {
    if (s.adx_1h < 15) return "<15";
    if (s.adx_1h < 20) return "15–20";
    if (s.adx_1h < 25) return "20–25";
    return "25–30";
  });

  // 3. RSI buckets
  const rsiBuckets = bucketize(allSignals, (s) => {
    if (s.rsi < 35) return "<35";
    if (s.rsi < 40) return "35–40";
    if (s.rsi < 45) return "40–45";
    return "45–48";
  });

  // 4. Volume/SMA ratio buckets
  const volBuckets = bucketize(allSignals, (s) => {
    if (s.volume_sma_ratio < 1.5) return "<1.5x";
    if (s.volume_sma_ratio < 2.0) return "1.5–2.0x";
    if (s.volume_sma_ratio < 3.0) return "2.0–3.0x";
    return "≥3.0x";
  });

  // 5. 4H distance from EMA50 buckets
  const distBuckets = bucketize(allSignals, (s) => {
    const d = s.close_4h_vs_ema50_4h_pct;
    if (d < -5) return "< -5%";
    if (d < -2) return "-5% to -2%";
    if (d < 0) return "-2% to 0%";
    return "≥ 0%";
  });

  // 6. Candle range vs ATR
  const rangeBuckets = bucketize(allSignals, (s) => {
    if (s.candle_range_vs_atr < 0.5) return "<0.5x ATR";
    if (s.candle_range_vs_atr < 1.0) return "0.5–1.0x ATR";
    if (s.candle_range_vs_atr < 1.5) return "1.0–1.5x ATR";
    return "1.5–2.2x ATR";
  });

  function buildSection(name: string, buckets: Map<string, SQSignal[]>): BucketStats[] {
    return Array.from(buckets.entries())
      .map(([label, sigs]) => computeBucketStats(label, sigs))
      .sort((a, b) => b.avg_r - a.avg_r);
  }

  const byBBWidth = buildSection("bb_width_ratio", bbWidthBuckets);
  const byADX = buildSection("adx_1h", adxBuckets);
  const byRSI = buildSection("rsi", rsiBuckets);
  const byVolume = buildSection("volume_sma_ratio", volBuckets);
  const byDist4H = buildSection("4h_distance_ema50", distBuckets);
  const byRange = buildSection("candle_range_vs_atr", rangeBuckets);

  // Overall stats
  const totalR = allSignals.map((s) => computeR(s.grade));
  const overall = {
    total_signals: allSignals.length,
    win_rate_tp1: allSignals.length > 0 ? round(allSignals.filter((s) => s.grade.hit_tp1).length / allSignals.length, 4) : 0,
    win_rate_tp2: allSignals.length > 0 ? round(allSignals.filter((s) => s.grade.hit_tp2).length / allSignals.length, 4) : 0,
    avg_r: allSignals.length > 0 ? round(totalR.reduce((a, b) => a + b, 0) / allSignals.length, 2) : 0,
    sl_hits: allSignals.filter((s) => s.grade.hit_sl && !s.grade.hit_tp1).length,
  };

  // Top symbols
  const bySymbol = bucketize(allSignals, (s) => s.symbol);
  const symbolStats = Array.from(bySymbol.entries())
    .map(([sym, sigs]) => ({ symbol: sym, ...computeBucketStats(sym, sigs) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return NextResponse.json({
    symbols_tested: symbols.length,
    errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    runtime_ms: Date.now() - startTime,
    overall,
    by_bb_width: byBBWidth,
    by_adx_1h: byADX,
    by_rsi: byRSI,
    by_volume_ratio: byVolume,
    by_4h_distance: byDist4H,
    by_candle_range: byRange,
    top_symbols: symbolStats,
  });
}
