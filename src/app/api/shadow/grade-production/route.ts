import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIN_AGE_MS = 48 * 60 * 60 * 1000;
const FORWARD_BARS = 48;

/**
 * GET /api/shadow/grade-production
 *
 * Grades accepted production trades using the same 48-forward-bar
 * approach used for shadow signal grading. Stores results in
 * production_signal_grades without mutating the decisions table.
 */
export async function GET() {
  const supabase = getSupabase();
  const now = Date.now();
  const cutoff = new Date(now - MIN_AGE_MS).toISOString();

  // 1. Find accepted production trades not yet graded
  const { data: decisions, error: decErr } = await supabase
    .from("decisions")
    .select("id, symbol, alert_type, decision, btc_regime, entry_price, stop_price, tp1_price, atr14_1h, created_at")
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT", "SQ_SHORT"])
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(50);

  if (decErr) {
    return NextResponse.json({ error: "Failed to fetch decisions", detail: decErr.message }, { status: 500 });
  }

  if (!decisions || decisions.length === 0) {
    return NextResponse.json({ status: "idle", graded: 0, message: "No ungradable decisions found" });
  }

  // 2. Find which ones already have grades
  const decisionIds = decisions.map(d => d.id);
  const { data: existingGrades } = await supabase
    .from("production_signal_grades")
    .select("decision_id")
    .in("decision_id", decisionIds);

  const alreadyGraded = new Set((existingGrades ?? []).map(g => g.decision_id));
  const ungraded = decisions.filter(d => !alreadyGraded.has(d.id));

  if (ungraded.length === 0) {
    return NextResponse.json({ status: "idle", graded: 0, message: "All eligible decisions already graded" });
  }

  let graded = 0;
  let failed = 0;
  const results: { symbol: string; decision: string; outcome_r: number; hit_tp1: boolean }[] = [];

  for (const dec of ungraded) {
    const entry = Number(dec.entry_price);
    const stop = Number(dec.stop_price);
    const atr = Number(dec.atr14_1h);

    if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0) {
      await insertGrade(supabase, dec, "FAILED");
      failed++;
      continue;
    }

    const isLong = dec.decision.toUpperCase().includes("LONG");
    const decisionTime = new Date(dec.created_at).getTime();
    const startAfter = decisionTime + 60 * 60 * 1000;

    // Fetch forward candles
    let futureBars: Kline[];
    try {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${dec.symbol}&interval=60&start=${startAfter}&limit=${FORWARD_BARS}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();

      if (data.retCode !== 0 || !data.result?.list?.length) {
        await insertGrade(supabase, dec, "FAILED");
        failed++;
        continue;
      }

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
        .filter((k: Kline) => k.startTime > decisionTime);
    } catch (err) {
      console.error(`[grade-production] Fetch error for ${dec.symbol}:`, err);
      await insertGrade(supabase, dec, "FAILED");
      failed++;
      continue;
    }

    if (futureBars.length < 10) continue; // Not enough data yet

    // Grade using inline logic (same approach as shadow/grade)
    const risk = Math.abs(entry - stop);
    if (risk === 0) {
      await insertGrade(supabase, dec, "FAILED");
      failed++;
      continue;
    }

    let tp1: number, tp2: number, tp3: number;
    if (isLong) {
      tp1 = entry + risk * 1.5;
      tp2 = entry + risk * 2.5;
      tp3 = entry + risk * 4.0;
    } else {
      tp1 = entry - risk * 1.5;
      tp2 = entry - risk * 2.5;
      tp3 = entry - risk * 4.0;
    }

    let hit_tp1 = false, hit_tp2 = false, hit_tp3 = false, hit_sl = false;
    let max_favorable = 0, max_adverse = 0;
    let bars_to_resolution = futureBars.length;

    for (let i = 0; i < futureBars.length; i++) {
      const bar = futureBars[i];
      if (isLong) {
        const fav = bar.high - entry;
        const adv = entry - bar.low;
        if (fav > max_favorable) max_favorable = fav;
        if (adv > max_adverse) max_adverse = adv;
        if (!hit_sl && bar.low <= stop) { hit_sl = true; if (!hit_tp1) { bars_to_resolution = i + 1; break; } }
        if (!hit_tp1 && bar.high >= tp1) hit_tp1 = true;
        if (!hit_tp2 && bar.high >= tp2) hit_tp2 = true;
        if (!hit_tp3 && bar.high >= tp3) hit_tp3 = true;
      } else {
        const fav = entry - bar.low;
        const adv = bar.high - entry;
        if (fav > max_favorable) max_favorable = fav;
        if (adv > max_adverse) max_adverse = adv;
        if (!hit_sl && bar.high >= stop) { hit_sl = true; if (!hit_tp1) { bars_to_resolution = i + 1; break; } }
        if (!hit_tp1 && bar.low <= tp1) hit_tp1 = true;
        if (!hit_tp2 && bar.low <= tp2) hit_tp2 = true;
        if (!hit_tp3 && bar.low <= tp3) hit_tp3 = true;
      }
      if (hit_tp3) { bars_to_resolution = i + 1; break; }
    }

    let outcome_r = 0;
    if (hit_tp3) outcome_r = 4.0;
    else if (hit_tp2) outcome_r = 2.5;
    else if (hit_tp1) outcome_r = 1.5;
    else if (hit_sl) outcome_r = -1;

    const { error: upsertErr } = await supabase.from("production_signal_grades").upsert({
      decision_id: dec.id,
      symbol: dec.symbol,
      alert_type: dec.alert_type,
      decision: dec.decision,
      btc_regime: dec.btc_regime,
      entry_price: entry,
      stop_price: stop,
      atr14_1h: atr,
      grade_status: "GRADED",
      graded_at: new Date().toISOString(),
      outcome_r,
      hit_tp1, hit_tp2, hit_tp3, hit_sl,
      bars_to_resolution,
      max_favorable, max_adverse,
    }, { onConflict: "decision_id" });

    if (upsertErr) {
      console.error(`[grade-production] Upsert failed for ${dec.symbol}:`, upsertErr);
      failed++;
    } else {
      graded++;
      results.push({ symbol: dec.symbol, decision: dec.decision, outcome_r: Math.round(outcome_r * 100) / 100, hit_tp1 });
    }
  }

  return NextResponse.json({ status: "completed", checked: ungraded.length, graded, failed, results });
}

async function insertGrade(
  supabase: ReturnType<typeof getSupabase>,
  dec: { id: string; symbol: string; alert_type: string; decision: string; btc_regime: string; entry_price: number; stop_price: number; atr14_1h: number },
  status: "FAILED"
) {
  await supabase.from("production_signal_grades").upsert({
    decision_id: dec.id,
    symbol: dec.symbol,
    alert_type: dec.alert_type,
    decision: dec.decision,
    btc_regime: dec.btc_regime,
    entry_price: dec.entry_price,
    stop_price: dec.stop_price,
    atr14_1h: dec.atr14_1h,
    grade_status: status,
    graded_at: new Date().toISOString(),
  }, { onConflict: "decision_id" });
}
