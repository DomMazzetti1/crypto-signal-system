import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";
import { gradeSignal, computeR } from "@/lib/grade-signal";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Minimum hours after candle_time before we attempt grading.
// 48 1H bars = 48 hours. This matches backtest FORWARD_BARS = 48.
const MIN_AGE_MS = 48 * 60 * 60 * 1000;
const FORWARD_BARS = 48;

export async function GET() {
  const supabase = getSupabase();
  const now = Date.now();

  // Find PENDING signals where at least one path passed
  // and enough time has elapsed for forward data
  const cutoff = new Date(now - MIN_AGE_MS).toISOString();

  const { data: pending, error } = await supabase
    .from("shadow_signals")
    .select("id, symbol, setup_type, candle_time, close_price, atr_1h, baseline_pass, relaxed_pass, shadow_only")
    .eq("grade_status", "PENDING")
    .lte("candle_time", cutoff)
    .or("baseline_pass.eq.true,relaxed_pass.eq.true")
    .order("candle_time", { ascending: true })
    .limit(50); // Process max 50 per call to stay within timeout

  if (error) {
    return NextResponse.json({ error: "Failed to fetch pending signals", detail: error.message }, { status: 500 });
  }

  if (!pending || pending.length === 0) {
    return NextResponse.json({ status: "idle", message: "No signals ready for grading", graded: 0 });
  }

  let graded = 0;
  let failed = 0;
  const results: { symbol: string; setup_type: string; candle_time: string; outcome_r: number; hit_tp1: boolean; hit_sl: boolean }[] = [];

  for (const row of pending) {
    const candleMs = new Date(row.candle_time).getTime();
    const isLong = row.setup_type.toUpperCase().includes("LONG");
    const rawEntry = Number(row.close_price);
    const atrVal = Number(row.atr_1h);

    // Validate required fields
    if (!Number.isFinite(rawEntry) || !Number.isFinite(atrVal) || rawEntry <= 0 || atrVal <= 0) {
      console.error(`[shadow/grade] Invalid fields for ${row.symbol} ${row.setup_type}: entry=${row.close_price} atr=${row.atr_1h}`);
      await supabase.from("shadow_signals")
        .update({ grade_status: "FAILED", graded_at: new Date().toISOString() })
        .eq("id", row.id);
      failed++;
      continue;
    }

    // Fetch 1H forward candles starting from the bar AFTER the signal bar
    // Bybit kline API: use start parameter = candleMs + 1H to get bars after signal
    const startAfterSignal = candleMs + 60 * 60 * 1000; // 1 hour after signal candle start
    let futureBars: Kline[];
    try {
      // Fetch forward candles using start parameter
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${row.symbol}&interval=60&start=${startAfterSignal}&limit=${FORWARD_BARS}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();

      if (data.retCode !== 0 || !data.result?.list?.length) {
        console.error(`[shadow/grade] Bybit kline fetch failed for ${row.symbol} ${row.setup_type}: retCode=${data.retCode}`);
        await supabase.from("shadow_signals")
          .update({ grade_status: "FAILED", graded_at: new Date().toISOString() })
          .eq("id", row.id);
        failed++;
        continue;
      }

      // Bybit returns newest-first, reverse to chronological
      futureBars = data.result.list
        .map((k: string[]) => ({
          startTime: Number(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }))
        .reverse()
        .filter((k: Kline) => k.startTime > candleMs); // Only bars AFTER signal bar
    } catch (err) {
      console.error(`[shadow/grade] Fetch error for ${row.symbol} ${row.setup_type} (candle=${row.candle_time}):`, err);
      await supabase.from("shadow_signals")
        .update({ grade_status: "FAILED", graded_at: new Date().toISOString() })
        .eq("id", row.id);
      failed++;
      continue;
    }

    if (futureBars.length < 10) {
      // Not enough forward data yet — skip but don't mark failed
      continue;
    }

    // Grade using shared gradeSignal function (same as backtest)
    const grade = gradeSignal(rawEntry, atrVal, isLong, futureBars);
    const outcomeR = computeR(grade);

    // Update shadow_signals with graded outcome
    const { error: gradeUpdateError } = await supabase.from("shadow_signals")
      .update({
        grade_status: "GRADED",
        graded_at: new Date().toISOString(),
        entry_price: grade.entry_price,
        stop_loss: grade.stop_loss,
        tp1: grade.tp1,
        tp2: grade.tp2,
        tp3: grade.tp3,
        hit_tp1: grade.hit_tp1,
        hit_tp2: grade.hit_tp2,
        hit_tp3: grade.hit_tp3,
        hit_sl: grade.hit_sl,
        outcome_r: outcomeR,
        max_favorable: grade.max_favorable,
        max_adverse: grade.max_adverse,
        bars_to_resolution: grade.bars_to_resolution,
      })
      .eq("id", row.id);
    if (gradeUpdateError) {
      console.error(`[shadow/grade] Failed to update graded result for ${row.symbol} ${row.setup_type}:`, gradeUpdateError);
    }

    graded++;
    results.push({
      symbol: row.symbol,
      setup_type: row.setup_type,
      candle_time: row.candle_time,
      outcome_r: Math.round(outcomeR * 100) / 100,
      hit_tp1: grade.hit_tp1,
      hit_sl: grade.hit_sl,
    });
  }

  console.log(`[shadow/grade] Graded ${graded}, failed ${failed}, pending checked ${pending.length}`);

  return NextResponse.json({
    status: "completed",
    pending_checked: pending.length,
    graded,
    failed,
    results,
  });
}
