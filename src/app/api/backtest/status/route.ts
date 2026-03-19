import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

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
  reviewer_shadow?: string;
  reviewer_shadow_action?: string;
}

interface SetupStats {
  count: number;
  win_rate: number;
  avg_r: number;
}

interface RegimeStats {
  count: number;
  win_rate: number;
}

function computeR(sig: BacktestSignal): number {
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

export async function GET(request: NextRequest) {
  const supabase = getSupabase();

  // Filter by run_group_id (preferred) or fall back to time window
  const runGroupId = request.nextUrl.searchParams.get("run_group_id");
  const hoursParam = request.nextUrl.searchParams.get("hours");
  const hours = hoursParam ? parseInt(hoursParam, 10) : 24;

  // Step 1: Fetch run metadata (without the large results JSONB)
  let runsQuery = supabase
    .from("backtest_runs")
    .select("id, run_at, symbols_tested, total_signals, summary, run_group_id")
    .order("run_at", { ascending: true });

  if (runGroupId) {
    runsQuery = runsQuery.eq("run_group_id", runGroupId);
  } else {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    runsQuery = runsQuery.gte("run_at", since);
  }

  const { data: runs, error } = await runsQuery;

  if (error) {
    return NextResponse.json({ error: "Failed to fetch backtest runs", detail: error.message }, { status: 500 });
  }

  if (!runs || runs.length === 0) {
    const filterDesc = runGroupId ? `run_group_id="${runGroupId}"` : `last ${hours} hours`;
    return NextResponse.json({
      message: `No backtest runs found for ${filterDesc}`,
      batches_found: 0,
    });
  }

  // Step 2: Fetch signals from backtest_signals table using run IDs
  const runIds = runs.map((r) => r.id);
  const allSignals: BacktestSignal[] = [];

  // Paginate through signals (Supabase default limit is 1000)
  for (const runId of runIds) {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data: signals, error: sigError } = await supabase
        .from("backtest_signals")
        .select("symbol, setup_type, candle_time, entry_price, stop_loss, tp1, tp2, tp3, hit_tp1, hit_tp2, hit_tp3, hit_sl, bars_to_resolution, max_favorable, max_adverse, regime, atr, reviewer_shadow, reviewer_shadow_action")
        .eq("backtest_run_id", runId)
        .range(offset, offset + PAGE - 1);

      if (sigError || !signals || signals.length === 0) break;

      for (const s of signals) {
        allSignals.push({
          symbol: s.symbol,
          setup_type: s.setup_type,
          candle_time: s.candle_time,
          entry_price: Number(s.entry_price),
          stop_loss: Number(s.stop_loss),
          tp1: Number(s.tp1),
          tp2: Number(s.tp2),
          tp3: Number(s.tp3),
          hit_tp1: s.hit_tp1,
          hit_tp2: s.hit_tp2,
          hit_tp3: s.hit_tp3,
          hit_sl: s.hit_sl,
          bars_to_resolution: s.bars_to_resolution,
          max_favorable: Number(s.max_favorable),
          max_adverse: Number(s.max_adverse),
          regime: s.regime,
          atr: Number(s.atr),
          reviewer_shadow: s.reviewer_shadow ?? undefined,
          reviewer_shadow_action: s.reviewer_shadow_action ?? undefined,
        });
      }

      if (signals.length < PAGE) break;
      offset += PAGE;
    }
  }

  // Build batch details and symbol set
  const allSymbols = new Set<string>();
  for (const s of allSignals) allSymbols.add(s.symbol);

  const batchDetails: { id: string; run_at: string; symbols_tested: number; total_signals: number; batch_symbols?: string[] }[] = [];
  for (const run of runs) {
    batchDetails.push({
      id: run.id,
      run_at: run.run_at,
      symbols_tested: run.symbols_tested,
      total_signals: run.total_signals,
      batch_symbols: run.summary?.batch_symbols,
    });
  }

  // Calculate combined statistics
  const total = allSignals.length;
  const wins = allSignals.filter((s) => s.hit_tp1).length;
  const losses = allSignals.filter((s) => s.hit_sl && !s.hit_tp1).length;
  const rValues = allSignals.map(computeR);
  const avgR = total > 0 ? rValues.reduce((a, b) => a + b, 0) / total : 0;
  const grossProfit = rValues.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rValues.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const expectancy = total > 0
    ? (wins / total) * (grossProfit / (wins || 1)) - (losses / total) * (grossLoss / (losses || 1))
    : 0;

  // By setup type
  const setupTypes = ["MR_LONG", "MR_SHORT", "SQ_SHORT"] as const;
  const by_setup: Record<string, SetupStats> = {};
  for (const st of setupTypes) {
    const subset = allSignals.filter((s) => s.setup_type === st);
    const subRs = subset.map(computeR);
    by_setup[st] = {
      count: subset.length,
      win_rate: subset.length > 0 ? subset.filter((s) => s.hit_tp1).length / subset.length : 0,
      avg_r: subset.length > 0 ? subRs.reduce((a, b) => a + b, 0) / subset.length : 0,
    };
  }

  // By regime
  const regimeTypes = ["bull", "bear", "sideways"] as const;
  const by_regime: Record<string, RegimeStats> = {};
  for (const rt of regimeTypes) {
    const subset = allSignals.filter((s) => s.regime === rt);
    by_regime[rt] = {
      count: subset.length,
      win_rate: subset.length > 0 ? subset.filter((s) => s.hit_tp1).length / subset.length : 0,
    };
  }

  // By setup × regime
  const by_setup_regime: Record<string, SetupStats> = {};
  for (const st of setupTypes) {
    for (const rt of regimeTypes) {
      const key = `${st}_${rt}`;
      const subset = allSignals.filter((s) => s.setup_type === st && s.regime === rt);
      if (subset.length === 0) continue;
      const subRs = subset.map(computeR);
      by_setup_regime[key] = {
        count: subset.length,
        win_rate: subset.filter((s) => s.hit_tp1).length / subset.length,
        avg_r: subRs.reduce((a, b) => a + b, 0) / subset.length,
      };
    }
  }

  // Reviewer shadow aggregation (deterministic approximation, NOT Claude parity)
  const shadowTiers = ["HIGH_CONFIDENCE", "MEDIUM_CONFIDENCE", "LOW_CONFIDENCE"] as const;
  const shadowActions = ["SEND", "REVIEW", "SKIP"] as const;
  const signalsWithShadow = allSignals.filter((s) => s.reviewer_shadow);

  const by_reviewer_shadow: Record<string, SetupStats> = {};
  for (const tier of shadowTiers) {
    const subset = signalsWithShadow.filter((s) => s.reviewer_shadow === tier);
    if (subset.length === 0) continue;
    const subRs = subset.map(computeR);
    by_reviewer_shadow[tier] = {
      count: subset.length,
      win_rate: subset.filter((s) => s.hit_tp1).length / subset.length,
      avg_r: subRs.reduce((a, b) => a + b, 0) / subset.length,
    };
  }

  const by_reviewer_action: Record<string, SetupStats> = {};
  for (const act of shadowActions) {
    const subset = signalsWithShadow.filter((s) => s.reviewer_shadow_action === act);
    if (subset.length === 0) continue;
    const subRs = subset.map(computeR);
    by_reviewer_action[act] = {
      count: subset.length,
      win_rate: subset.filter((s) => s.hit_tp1).length / subset.length,
      avg_r: subRs.reduce((a, b) => a + b, 0) / subset.length,
    };
  }

  // Backtest period
  const candleTimes = allSignals.map((s) => new Date(s.candle_time).getTime());
  const earliestMs = candleTimes.length > 0 ? Math.min(...candleTimes) : 0;
  const latestMs = candleTimes.length > 0 ? Math.max(...candleTimes) : 0;
  const tradingDays = candleTimes.length > 0 ? Math.round((latestMs - earliestMs) / (1000 * 60 * 60 * 24)) : 0;

  return NextResponse.json({
    run_group_id: runGroupId ?? null,
    combined_from_batches: runs.length,
    batches: batchDetails,
    symbols_tested: allSymbols.size,
    symbols: Array.from(allSymbols).sort(),
    backtest_period: {
      from: earliestMs > 0 ? new Date(earliestMs).toISOString() : null,
      to: latestMs > 0 ? new Date(latestMs).toISOString() : null,
      trading_days: tradingDays,
    },
    total_signals: total,
    win_rate_tp1: total > 0 ? round(wins / total, 4) : 0,
    profit_factor: round(profitFactor, 2),
    expectancy: round(expectancy, 4),
    avg_r: round(avgR, 2),
    by_setup: Object.fromEntries(
      Object.entries(by_setup).map(([k, v]) => [
        k,
        { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
      ])
    ),
    by_regime: Object.fromEntries(
      Object.entries(by_regime).map(([k, v]) => [
        k,
        { count: v.count, win_rate: round(v.win_rate, 4) },
      ])
    ),
    by_setup_regime: Object.fromEntries(
      Object.entries(by_setup_regime).map(([k, v]) => [
        k,
        { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
      ])
    ),
    // Deterministic reviewer shadow (NOT Claude parity — rule-based approximation)
    reviewer_shadow: signalsWithShadow.length > 0 ? {
      note: "Deterministic approximation only. Not Claude parity.",
      signals_classified: signalsWithShadow.length,
      by_confidence: Object.fromEntries(
        Object.entries(by_reviewer_shadow).map(([k, v]) => [
          k,
          { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
        ])
      ),
      by_action: Object.fromEntries(
        Object.entries(by_reviewer_action).map(([k, v]) => [
          k,
          { count: v.count, win_rate: round(v.win_rate, 4), avg_r: round(v.avg_r, 2) },
        ])
      ),
    } : undefined,
  });
}
