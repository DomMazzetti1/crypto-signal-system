import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";
import {
  computeIndicators,
  detectSignalsWithParams,
  SignalParams,
  DEFAULT_SIGNAL_PARAMS,
} from "@/lib/signals";
import { runGateB, GateBInput } from "@/lib/gate-b";
import { calculateLevels } from "@/lib/levels";
import { computeHTFTrend } from "@/lib/ta";
import { classifyRegimeFromCandles } from "@/lib/regime";
import { gradeSignal, computeR, GradeResult } from "@/lib/grade-signal";
import { runWithConcurrency, readCache, enforceProductionLimits, round } from "@/lib/backtest-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WARMUP_BARS = 150;
const FORWARD_BARS = 48;
const MAX_CONCURRENT = 4;

// ── Types ────────────────────────────────────────────────

interface StageSignal {
  symbol: string;
  setup_type: string;
  candle_time: number;
  direction: "long" | "short";
  mark_price: number;
  atr_1h: number;
  // Gate results
  gate_a_pass: boolean;
  gate_a_note: string;
  gate_b_pass: boolean;
  gate_b_reason: string | null;
  regime: string;
  trend_4h: string;
  // Levels
  rr_tp1: number;
  // Grading
  grade: GradeResult;
  r_multiple: number;
}

interface StageStats {
  count: number;
  win_rate_tp1: number;
  avg_r: number;
  by_setup: Record<string, { count: number; win_rate_tp1: number; avg_r: number }>;
}

function computeStageStats(signals: StageSignal[]): StageStats {
  const n = signals.length;
  if (n === 0) return { count: 0, win_rate_tp1: 0, avg_r: 0, by_setup: {} };
  const wins = signals.filter(s => s.grade.hit_tp1).length;
  const rs = signals.map(s => s.r_multiple);
  const avgR = round(rs.reduce((a, b) => a + b, 0) / n, 2);

  const bySetup: Record<string, { count: number; win_rate_tp1: number; avg_r: number }> = {};
  for (const st of ["MR_LONG", "MR_SHORT", "SQ_SHORT"]) {
    const sub = signals.filter(s => s.setup_type === st);
    if (sub.length > 0) {
      const subWins = sub.filter(s => s.grade.hit_tp1).length;
      const subRs = sub.map(s => s.r_multiple);
      bySetup[st] = {
        count: sub.length,
        win_rate_tp1: round(subWins / sub.length, 4),
        avg_r: round(subRs.reduce((a, b) => a + b, 0) / sub.length, 2),
      };
    }
  }

  return { count: n, win_rate_tp1: round(wins / n, 4), avg_r: avgR, by_setup: bySetup };
}

function candlesUpTo(candles: Kline[], beforeMs: number): Kline[] {
  return candles.filter(c => c.startTime < beforeMs);
}

// ── Main handler ─────────────────────────────────────────

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  let body: {
    symbols?: string[];
    baseline?: SignalParams;
    relaxed?: SignalParams;
    cache_only?: boolean;
  };
  try { body = await request.json(); } catch { body = {}; }

  const cacheOnly = body.cache_only ?? false;

  // Resolve symbols
  const supabase = getSupabase();
  let symbols: string[];
  if (body.symbols && body.symbols.length > 0) {
    symbols = body.symbols;
  } else {
    const { data: rows, error } = await supabase
      .from("universe").select("symbol").eq("is_eligible", true).order("symbol");
    if (error || !rows) return NextResponse.json({ error: "Failed to read universe" }, { status: 500 });
    symbols = rows.map(r => r.symbol);
  }

  const guardrailErr = enforceProductionLimits(symbols, cacheOnly);
  if (guardrailErr) return guardrailErr;

  const baselineParams = body.baseline ?? DEFAULT_SIGNAL_PARAMS;
  const relaxedParams = body.relaxed ?? { ...DEFAULT_SIGNAL_PARAMS, sq_trigger_mode: "state" as const };

  console.log(`[pipeline-replay] Starting: ${symbols.length} symbols`);

  // ── Fetch all candle data (shared across variants) ─────

  const symbolCandles = new Map<string, { c1h: Kline[]; c4h: Kline[]; c1d: Kline[] }>();
  const errors: string[] = [];

  await runWithConcurrency(symbols, MAX_CONCURRENT, async (symbol) => {
    try {
      const [c1h, c4h, c1d] = await Promise.all([
        readCache(symbol, "60"),
        readCache(symbol, "240"),
        readCache(symbol, "D"),
      ]);
      if (c1h.length === 0) throw new Error("No 1H cache");
      symbolCandles.set(symbol, { c1h, c4h, c1d });
    } catch (err) {
      errors.push(`${symbol}: ${String(err).slice(0, 80)}`);
    }
  });

  // Fetch BTC candles once for regime classification
  const btc4h = await readCache("BTCUSDT", "240");
  const btc1d = await readCache("BTCUSDT", "D");
  const hasBtcData = btc4h.length >= 50 && btc1d.length >= 220;

  console.log(`[pipeline-replay] Data loaded: ${symbolCandles.size} symbols, BTC regime data: ${hasBtcData}`);

  // ── Run one variant through the full pipeline ──────────

  function runVariant(label: string, params: SignalParams): StageSignal[] {
    const allSignals: StageSignal[] = [];

    for (const [symbol, { c1h, c4h, c1d }] of Array.from(symbolCandles.entries())) {
      if (c1h.length < WARMUP_BARS + FORWARD_BARS) continue;

      for (let i = WARMUP_BARS; i < c1h.length - FORWARD_BARS; i++) {
        const slice1h = c1h.slice(0, i + 1);
        const barTime = c1h[i].startTime;
        const slice4h = candlesUpTo(c4h, barTime + 1);
        const slice1d = candlesUpTo(c1d, barTime + 1);
        if (slice4h.length < 14 || slice1d.length < 14) continue;

        const ind = computeIndicators(slice1h, slice4h, slice1d);
        if (!ind) continue;

        const detected = detectSignalsWithParams(symbol, ind, params);
        if (detected.length === 0) continue;

        // Compute HTF trend from the symbol's own 4H candles
        const htfTrend = computeHTFTrend(slice4h);
        const atr1h = ind.atr_1h;

        // Compute BTC regime at this point in time
        let regime = "sideways";
        if (hasBtcData) {
          const btc4hSlice = candlesUpTo(btc4h, barTime + 1);
          const btc1dSlice = candlesUpTo(btc1d, barTime + 1);
          if (btc4hSlice.length >= 50 && btc1dSlice.length >= 220) {
            const regimeResult = classifyRegimeFromCandles(btc4hSlice, btc1dSlice);
            regime = regimeResult.btc_regime;
          }
        }

        const futureBars = c1h.slice(i + 1, i + 1 + FORWARD_BARS);

        for (const sig of detected) {
          const direction: "long" | "short" = sig.type.toLowerCase().includes("short") ? "short" : "long";
          const markPrice = ind.close;

          // Calculate levels (exact — same function as live)
          const levels = calculateLevels(markPrice, atr1h, direction);

          // Gate A: approximated — we assume pass for all universe symbols
          // (Gate A checks live orderbook freshness and spread, not available historically)
          const gateAPass = true;
          const gateANote = "approximated: assumed pass for universe symbol";

          // Gate B: exact — uses trend, regime, ATR, R:R (all computed from candles)
          const gateBInput: GateBInput = {
            alertType: sig.type,
            trend4h: htfTrend.trend,
            btcRegime: regime as "bull" | "bear" | "sideways",
            atr1h,
            markPrice,
            rrTp1: levels.rr_tp1,
            rsi: ind.rsi,
            adx1h: ind.adx_1h,
            volume: ind.volume,
            sma20Volume: ind.sma20_volume,
          };
          const gateB = runGateB(gateBInput);

          // Grade against future bars (exact)
          const isLong = direction === "long";
          const grade = gradeSignal(markPrice, atr1h, isLong, futureBars);
          const rMultiple = computeR(grade);

          allSignals.push({
            symbol,
            setup_type: sig.type,
            candle_time: barTime,
            direction,
            mark_price: markPrice,
            atr_1h: atr1h,
            gate_a_pass: gateAPass,
            gate_a_note: gateANote,
            gate_b_pass: gateB.passed,
            gate_b_reason: gateB.reason,
            regime,
            trend_4h: htfTrend.trend,
            rr_tp1: levels.rr_tp1,
            grade,
            r_multiple: rMultiple,
          });
        }
      }
    }

    return allSignals;
  }

  // ── Run both variants ──────────────────────────────────

  const baselineSignals = runVariant("baseline", baselineParams);
  const relaxedSignals = runVariant("relaxed", relaxedParams);

  function buildResult(label: string, signals: StageSignal[]) {
    const raw = signals;
    const afterGateA = signals.filter(s => s.gate_a_pass);
    const afterGateB = afterGateA.filter(s => s.gate_b_pass);
    // No Claude in replay — final = after Gate B
    const final = afterGateB;

    // Gate B rejection breakdown
    const gateBRejects: Record<string, number> = {};
    for (const s of afterGateA.filter(s => !s.gate_b_pass)) {
      const reason = s.gate_b_reason ?? "unknown";
      gateBRejects[reason] = (gateBRejects[reason] || 0) + 1;
    }

    return {
      label,
      raw_signals: computeStageStats(raw),
      after_gate_a: computeStageStats(afterGateA),
      after_gate_b: computeStageStats(afterGateB),
      claude_skipped: "Claude reviewer not run in replay mode — would further filter after Gate B",
      final_signals: computeStageStats(final),
      gate_b_rejections: gateBRejects,
    };
  }

  const baseline = buildResult("baseline", baselineSignals);
  const relaxed = buildResult("relaxed", relaxedSignals);

  // Compute deltas
  const delta = {
    raw_count: `${baseline.raw_signals.count} → ${relaxed.raw_signals.count} (${relaxed.raw_signals.count - baseline.raw_signals.count > 0 ? "+" : ""}${relaxed.raw_signals.count - baseline.raw_signals.count})`,
    after_gate_b_count: `${baseline.after_gate_b.count} → ${relaxed.after_gate_b.count} (${relaxed.after_gate_b.count - baseline.after_gate_b.count > 0 ? "+" : ""}${relaxed.after_gate_b.count - baseline.after_gate_b.count})`,
    final_win_rate: `${baseline.final_signals.win_rate_tp1} → ${relaxed.final_signals.win_rate_tp1} (${round(relaxed.final_signals.win_rate_tp1 - baseline.final_signals.win_rate_tp1, 4) > 0 ? "+" : ""}${round(relaxed.final_signals.win_rate_tp1 - baseline.final_signals.win_rate_tp1, 4)})`,
    final_avg_r: `${baseline.final_signals.avg_r} → ${relaxed.final_signals.avg_r} (${round(relaxed.final_signals.avg_r - baseline.final_signals.avg_r, 2) > 0 ? "+" : ""}${round(relaxed.final_signals.avg_r - baseline.final_signals.avg_r, 2)})`,
    gate_b_filter_rate_baseline: baseline.raw_signals.count > 0 ? `${round((1 - baseline.after_gate_b.count / baseline.raw_signals.count) * 100, 1)}%` : "n/a",
    gate_b_filter_rate_relaxed: relaxed.raw_signals.count > 0 ? `${round((1 - relaxed.after_gate_b.count / relaxed.raw_signals.count) * 100, 1)}%` : "n/a",
  };

  return NextResponse.json({
    symbols_tested: symbolCandles.size,
    fetch_errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    runtime_ms: Date.now() - startTime,
    approximations: {
      gate_a: "Assumed PASS for all signals. Gate A checks live orderbook freshness and spread — not available from historical candle data. Universe symbols are pre-screened for liquidity.",
      claude_reviewer: "Not run. Claude reviewer requires live API call (~2s each). Gate B is the last filter in replay mode.",
      regime: hasBtcData ? "Exact — computed from cached BTC 4H/1D candles at each bar" : "Approximated — insufficient BTC cache, defaulted to sideways/mixed",
      gate_b: "Exact — uses trend_4h, regime, ATR, R:R, RSI, ADX, volume. All derived from candle data.",
      grading: "Exact — uses 48 forward 1H bars from cache.",
    },
    baseline,
    relaxed,
    delta,
  });
}
