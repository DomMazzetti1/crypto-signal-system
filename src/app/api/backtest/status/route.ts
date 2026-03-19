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

  // Optional: ?hours=24 to limit how far back to look (default: 24h)
  const hoursParam = request.nextUrl.searchParams.get("hours");
  const hours = hoursParam ? parseInt(hoursParam, 10) : 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Fetch all batch runs from the time window
  const { data: runs, error } = await supabase
    .from("backtest_runs")
    .select("id, created_at, symbols_tested, total_signals, results, summary")
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch backtest runs", detail: error.message }, { status: 500 });
  }

  if (!runs || runs.length === 0) {
    return NextResponse.json({
      message: `No backtest runs found in the last ${hours} hours`,
      batches_found: 0,
    });
  }

  // Combine all signals from all batches
  const allSignals: BacktestSignal[] = [];
  const allSymbols = new Set<string>();
  const batchDetails: { id: number; created_at: string; symbols_tested: number; total_signals: number; batch_symbols?: string[] }[] = [];

  for (const run of runs) {
    const signals = (run.results ?? []) as BacktestSignal[];
    allSignals.push(...signals);
    for (const s of signals) {
      allSymbols.add(s.symbol);
    }
    batchDetails.push({
      id: run.id,
      created_at: run.created_at,
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

  // Backtest period
  const candleTimes = allSignals.map((s) => new Date(s.candle_time).getTime());
  const earliestMs = candleTimes.length > 0 ? Math.min(...candleTimes) : 0;
  const latestMs = candleTimes.length > 0 ? Math.max(...candleTimes) : 0;
  const tradingDays = candleTimes.length > 0 ? Math.round((latestMs - earliestMs) / (1000 * 60 * 60 * 24)) : 0;

  return NextResponse.json({
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
  });
}
