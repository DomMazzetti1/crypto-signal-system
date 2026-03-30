import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { fetchKlines, Kline } from "@/lib/bybit";
import { computeIndicators, detectSignalsTiered, DEFAULT_SIGNAL_PARAMS } from "@/lib/signals";
import { classifyRegimeFromCandles } from "@/lib/regime";
import { gradeSignal, computeR } from "@/lib/grade-signal";
import { computeCompositeScore } from "@/lib/scoring";
import { runGateB } from "@/lib/gate-b";
import { computeHTFTrend } from "@/lib/ta";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FORWARD_BARS = 48;

/**
 * GET /api/backtest/full-run
 *
 * Re-runs the full backtest with all current production filters.
 * Stores every result persistently in backtest_results.
 * Accepts ?offset=N to resume from symbol index N.
 * Protected by CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getSupabase();
  const offset = Number(request.nextUrl.searchParams.get("offset") || "0");
  const batchSize = Number(request.nextUrl.searchParams.get("batch") || "5");
  const runId = request.nextUrl.searchParams.get("run_id") ||
    `run_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;

  // Get eligible symbols
  const { data: universeRows, error: uniErr } = await supabase
    .from("universe")
    .select("symbol")
    .eq("is_eligible", true)
    .order("symbol");

  if (uniErr || !universeRows) {
    return NextResponse.json({ error: "Failed to read universe" }, { status: 500 });
  }

  const allSymbols = universeRows.map(r => r.symbol);
  const symbols = allSymbols.slice(offset, offset + batchSize);

  if (symbols.length === 0) {
    // All symbols processed — compute summary
    return computeSummary(supabase, runId, allSymbols.length);
  }

  // Fetch BTC candles once for regime classification
  let btc4h: Kline[], btc1d: Kline[];
  try {
    [btc4h, btc1d] = await Promise.all([
      fetchKlines("BTCUSDT", "240", 1000),
      fetchKlines("BTCUSDT", "D", 400),
    ]);
  } catch (err) {
    return NextResponse.json({ error: `BTC candle fetch failed: ${err}` }, { status: 502 });
  }

  let totalSignals = 0;
  let totalStored = 0;
  const errors: string[] = [];

  for (const symbol of symbols) {
    await new Promise(r => setTimeout(r, 200)); // Rate limit

    let candles1h: Kline[], candles4h: Kline[], candles1d: Kline[];
    try {
      [candles1h, candles4h, candles1d] = await Promise.all([
        fetchKlines(symbol, "60", 1000),
        fetchKlines(symbol, "240", 500),
        fetchKlines(symbol, "D", 400),
      ]);
    } catch (err) {
      errors.push(`${symbol}: candle fetch failed — ${err}`);
      continue;
    }

    if (candles1h.length < 200) {
      errors.push(`${symbol}: insufficient 1H candles (${candles1h.length})`);
      continue;
    }

    // Sliding window: for each 1H candle as potential signal point
    const warmup = 150;
    for (let barIdx = warmup; barIdx < candles1h.length - FORWARD_BARS; barIdx++) {
      const slice1h = candles1h.slice(0, barIdx + 1);
      const currentBar = candles1h[barIdx];
      const barTime = currentBar.startTime;

      // Filter 4H/1D to only candles available at signal time
      const slice4h = candles4h.filter(c => c.startTime <= barTime);
      const slice1d = candles1d.filter(c => c.startTime <= barTime);

      if (slice4h.length < 14 || slice1d.length < 14) continue;

      // Compute indicators on the last 150 1H candles
      const indSlice1h = slice1h.slice(-150);
      const indSlice4h = slice4h.slice(-60);
      const indSlice1d = slice1d.slice(-60);
      const indicators = computeIndicators(indSlice1h, indSlice4h, indSlice1d);
      if (!indicators) continue;

      // Detect signals
      const signals = detectSignalsTiered(symbol, indicators, DEFAULT_SIGNAL_PARAMS);
      if (signals.length === 0) continue;

      // Classify regime at signal time
      const btc4hAtTime = btc4h.filter(c => c.startTime <= barTime).slice(-50);
      const btc1dAtTime = btc1d.filter(c => c.startTime <= barTime).slice(-220);
      let regime = "sideways";
      if (btc4hAtTime.length >= 14 && btc1dAtTime.length >= 200) {
        try {
          const regimeResult = classifyRegimeFromCandles(btc4hAtTime, btc1dAtTime);
          regime = regimeResult.btc_regime;
        } catch { /* fall back to sideways */ }
      }

      // HTF trend for Gate B
      const trend4h = computeHTFTrend(indSlice4h);

      for (const sig of signals) {
        // Skip DATA_ONLY for backtest
        if (sig.tier === "DATA_ONLY") continue;

        const isLong = sig.type.includes("LONG");
        const rawEntry = indicators.close;
        const atrVal = indicators.atr_1h;

        // Max stop distance filter (same as production pipeline)
        const maxStopDistPct = parseFloat(process.env.MAX_STOP_DIST_PCT ?? "0.08");
        const riskDist = atrVal * 1.5;
        const stopDistPct = riskDist / rawEntry;
        if (stopDistPct > maxStopDistPct) continue;

        // Gate B filter
        const gateB = runGateB({
          alertType: sig.type,
          trend4h: trend4h.trend,
          btcRegime: regime as "bull" | "bear" | "sideways",
          atr1h: atrVal,
          markPrice: rawEntry,
          rrTp1: 1.5,
          rsi: indicators.rsi,
          adx1h: indicators.adx_1h,
          volume: indicators.volume,
          sma20Volume: indicators.sma20_volume,
        });
        if (!gateB.passed) continue;

        // Grade using forward bars
        const futureBars = candles1h.slice(barIdx + 1, barIdx + 1 + FORWARD_BARS);
        if (futureBars.length < 10) continue;

        const grade = gradeSignal(rawEntry, atrVal, isLong, futureBars);
        const outcomeR = computeR(grade);

        // Derive outcome
        let gradedOutcome = "EXPIRED";
        let resolutionPath = "ENTRY->EXPIRED";
        if (grade.hit_tp3) { gradedOutcome = "WIN_FULL"; resolutionPath = "ENTRY->TP1->TP2->TP3"; }
        else if (grade.hit_sl && !grade.hit_tp1) { gradedOutcome = "LOSS"; resolutionPath = "ENTRY->SL"; }
        else if (grade.hit_sl && grade.hit_tp1) { gradedOutcome = "WIN_PARTIAL_THEN_SL"; resolutionPath = grade.hit_tp2 ? "ENTRY->TP1->TP2->SL" : "ENTRY->TP1->SL"; }
        else if (grade.hit_tp1) { gradedOutcome = "WIN_PARTIAL_EXPIRED"; resolutionPath = grade.hit_tp2 ? "ENTRY->TP1->TP2->EXPIRED" : "ENTRY->TP1->EXPIRED"; }

        const score = computeCompositeScore({
          atr14_1h: atrVal,
          mark_price: rawEntry,
          vol_ratio: indicators.sma20_volume > 0 ? indicators.volume / indicators.sma20_volume : null,
          alert_type: sig.type,
        });

        const closeAt48h = futureBars.length > 0 ? futureBars[futureBars.length - 1].close : null;

        const { error: insertErr } = await supabase.from("backtest_results").insert({
          backtest_run_id: runId,
          symbol,
          alert_type: sig.type,
          tier: sig.tier,
          direction: isLong ? "LONG" : "SHORT",
          btc_regime: regime,
          entry_price: grade.entry_price,
          stop_price: grade.stop_loss,
          tp1_price: grade.tp1,
          tp2_price: grade.tp2,
          tp3_price: grade.tp3,
          signal_created_at: new Date(barTime).toISOString(),
          graded_outcome: gradedOutcome,
          outcome_r: Math.round(outcomeR * 100) / 100,
          resolution_path: resolutionPath,
          hit_tp1: grade.hit_tp1,
          hit_tp2: grade.hit_tp2,
          hit_tp3: grade.hit_tp3,
          hit_sl: grade.hit_sl,
          bars_to_resolution: grade.bars_to_resolution,
          max_favorable: grade.max_favorable,
          max_adverse: grade.max_adverse,
          close_at_48h_price: closeAt48h,
          composite_score: score.composite_score,
          vol_ratio: indicators.sma20_volume > 0 ? indicators.volume / indicators.sma20_volume : null,
          bb_width: indicators.bb_width_ratio,
          rsi: indicators.rsi,
          adx_1h: indicators.adx_1h,
          atr_pct: rawEntry > 0 ? atrVal / rawEntry : null,
        });

        if (insertErr) {
          errors.push(`${symbol} ${sig.type}: insert failed — ${insertErr.message}`);
        } else {
          totalStored++;
        }
        totalSignals++;
      }
    }
  }

  const nextOffset = offset + batchSize;
  const remaining = allSymbols.length - nextOffset;

  return NextResponse.json({
    status: remaining > 0 ? "in_progress" : "batch_complete",
    run_id: runId,
    symbols_processed: symbols,
    signals_found: totalSignals,
    signals_stored: totalStored,
    offset,
    next_offset: remaining > 0 ? nextOffset : null,
    remaining_symbols: Math.max(0, remaining),
    errors: errors.length > 0 ? errors : undefined,
    note: remaining > 0
      ? `Call again with ?offset=${nextOffset}&run_id=${runId} to continue`
      : "All symbols processed. Call with offset beyond total to get summary.",
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeSummary(supabase: any, runId: string, totalSymbols: number) {
  const { data: results } = await supabase
    .from("backtest_results")
    .select("graded_outcome, outcome_r, btc_regime, tier")
    .eq("backtest_run_id", runId);

  if (!results || results.length === 0) {
    return NextResponse.json({ status: "summary", run_id: runId, total_signals: 0, message: "No results found" });
  }

  function stats(rows: typeof results) {
    const total = rows.length;
    const wins = rows.filter((r: { graded_outcome: string }) =>
      r.graded_outcome === "WIN_FULL" || r.graded_outcome === "WIN_PARTIAL_THEN_SL" || r.graded_outcome === "WIN_PARTIAL_EXPIRED"
    ).length;
    const rValues = rows.map((r: { outcome_r: number }) => Number(r.outcome_r) || 0);
    const avgR = total > 0 ? rValues.reduce((a: number, b: number) => a + b, 0) / total : 0;
    const grossProfit = rValues.filter((r: number) => r > 0).reduce((a: number, b: number) => a + b, 0);
    const grossLoss = Math.abs(rValues.filter((r: number) => r < 0).reduce((a: number, b: number) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    return {
      total,
      win_rate: total > 0 ? Math.round(wins / total * 1000) / 10 : 0,
      avg_r: Math.round(avgR * 100) / 100,
      profit_factor: profitFactor === Infinity ? "Infinity" : Math.round(profitFactor * 100) / 100,
    };
  }

  const byRegime: Record<string, ReturnType<typeof stats>> = {};
  const byTier: Record<string, ReturnType<typeof stats>> = {};
  for (const regime of ["bull", "bear", "sideways"]) {
    const subset = results.filter((r: { btc_regime: string }) => r.btc_regime === regime);
    if (subset.length > 0) byRegime[regime] = stats(subset);
  }
  for (const tier of ["STRICT_PROD", "RELAXED_PROD"]) {
    const subset = results.filter((r: { tier: string }) => r.tier === tier);
    if (subset.length > 0) byTier[tier] = stats(subset);
  }

  const summary = {
    status: "summary",
    run_id: runId,
    total_symbols: totalSymbols,
    overall: stats(results),
    by_regime: byRegime,
    by_tier: byTier,
  };

  console.log(`[backtest/full-run] Summary for ${runId}:`, JSON.stringify(summary));
  return NextResponse.json(summary);
}
