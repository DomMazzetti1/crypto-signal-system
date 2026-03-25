import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SETUP_TYPE = "SQ_SHORT_ADX_SHADOW";
const MIN_GRADED_FOR_DECISION = 10;

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export async function GET() {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Fetch all graded SQ shadow rows (cumulative, same as sq-status)
  const { data: rows, error } = await supabase
    .from("shadow_signals")
    .select("baseline_pass, relaxed_pass, grade_status, outcome_r, hit_tp1, adx_1h")
    .eq("setup_type", SETUP_TYPE);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch shadow data", detail: error.message }, { status: 500 });
  }

  const all = rows ?? [];
  const graded = all.filter((r) => r.grade_status === "GRADED");
  const strictPass = graded.filter((r) => r.relaxed_pass);
  const baselineOnly = graded.filter((r) => r.baseline_pass && !r.relaxed_pass);

  const stats = (subset: typeof graded) => {
    const n = subset.length;
    if (n === 0) return { count: 0, win_rate: 0, avg_r: 0 };
    const wins = subset.filter((r) => r.hit_tp1).length;
    const rs = subset.map((r) => Number(r.outcome_r) || 0);
    return {
      count: n,
      win_rate: round(wins / n, 4),
      avg_r: round(rs.reduce((a, b) => a + b, 0) / n, 2),
    };
  };

  const strict = stats(strictPass);
  const baseline = stats(baselineOnly);

  // Decision logic (same as sq-status)
  let decision: string;
  if (graded.length < MIN_GRADED_FOR_DECISION || strict.count === 0) {
    decision = "insufficient data";
  } else if (baseline.count === 0) {
    decision = "strict better so far";
  } else {
    const rDiff = strict.avg_r - baseline.avg_r;
    const wrDiff = strict.win_rate - baseline.win_rate;
    if (rDiff > 0.1 && wrDiff >= -0.05) decision = "strict better so far";
    else if (rDiff < -0.1 && wrDiff <= 0.05) decision = "baseline better so far";
    else decision = "roughly equal";
  }

  // Fetch previous day's summary to detect decision change
  const { data: prevRows } = await supabase
    .from("shadow_daily_summary")
    .select("date, decision")
    .lt("date", today)
    .order("date", { ascending: false })
    .limit(1);

  const prevDecision = prevRows?.[0]?.decision ?? null;
  const decisionChanged = prevDecision !== null && prevDecision !== decision;

  // Upsert today's summary
  const summary = {
    date: today,
    total_rows: all.length,
    graded_rows: graded.length,
    strict_count: strict.count,
    strict_win_rate: strict.win_rate,
    strict_avg_r: strict.avg_r,
    baseline_count: baseline.count,
    baseline_win_rate: baseline.win_rate,
    baseline_avg_r: baseline.avg_r,
    decision,
  };

  const { error: upsertErr } = await supabase
    .from("shadow_daily_summary")
    .upsert(summary, { onConflict: "date" });

  if (upsertErr) {
    console.error("[sq-daily-rollup] Upsert failed:", upsertErr);
    return NextResponse.json({ error: "Failed to store summary", detail: upsertErr.message }, { status: 500 });
  }

  // Log decision change
  if (decisionChanged) {
    console.log(`[sq-daily-rollup] DECISION CHANGED: "${prevDecision}" → "${decision}"`);

    // Optional: Telegram alert on decision change
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      const text = `SQ Shadow Experiment\nDecision changed: "${prevDecision}" → "${decision}"\n\nStrict (ADX<15): ${strict.count} signals, WR=${strict.win_rate}, R=${strict.avg_r}\nBaseline (ADX<30): ${baseline.count} signals, WR=${baseline.win_rate}, R=${baseline.avg_r}`;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      }).catch((err) => console.error("[sq-daily-rollup] Telegram alert failed:", err));
    }
  }

  return NextResponse.json({
    ...summary,
    decision_changed: decisionChanged,
    previous_decision: prevDecision,
  });
}
