import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIN_AGE_MS = 48 * 60 * 60 * 1000;
const FORWARD_BARS = 48;

/**
 * Graded outcome values (persisted to decisions.graded_outcome):
 *   WIN_FULL    — all active TPs hit before stop
 *   WIN_PARTIAL — TP1 hit but stop hit before full target
 *   LOSS        — stop hit before any TP
 *   EXPIRED     — neither full win nor stop within grading window
 *   INVALID     — invalid levels or missing data
 *
 * Resolution path values (persisted to decisions.resolution_path):
 *   ENTRY->SL, ENTRY->TP1->SL, ENTRY->TP1->TP2->SL,
 *   ENTRY->TP1->TP2->TP3, ENTRY->TP1->EXPIRED, ENTRY->EXPIRED,
 *   INVALID
 */

/**
 * GET /api/shadow/grade-production
 *
 * Grades accepted production trades using the same 48-forward-bar
 * approach used for shadow signal grading. Stores results in
 * production_signal_grades AND writes lifecycle fields back to decisions.
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
  const results: { symbol: string; decision: string; outcome_r: number; hit_tp1: boolean; graded_outcome: string }[] = [];

  for (const dec of ungraded) {
    const entry = Number(dec.entry_price);
    const stop = Number(dec.stop_price);
    const atr = Number(dec.atr14_1h);

    if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0) {
      await insertGrade(supabase, dec, "FAILED");
      await writeLifecycleToDecision(supabase, dec.id, {
        graded_outcome: "INVALID",
        resolution_path: "INVALID",
        resolved_at: new Date().toISOString(),
      });
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
      await writeLifecycleToDecision(supabase, dec.id, {
        graded_outcome: "INVALID",
        resolution_path: "INVALID",
        resolved_at: new Date().toISOString(),
      });
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

    // Lifecycle: track first-hit timestamps (bar start time as consistent timestamp)
    let tp1HitAt: string | null = null;
    let tp2HitAt: string | null = null;
    let tp3HitAt: string | null = null;
    let stoppedAt: string | null = null;

    for (let i = 0; i < futureBars.length; i++) {
      const bar = futureBars[i];
      const barTime = new Date(bar.startTime).toISOString();

      if (isLong) {
        const fav = bar.high - entry;
        const adv = entry - bar.low;
        if (fav > max_favorable) max_favorable = fav;
        if (adv > max_adverse) max_adverse = adv;

        if (!hit_sl && bar.low <= stop) {
          hit_sl = true;
          stoppedAt = barTime;
          if (!hit_tp1) { bars_to_resolution = i + 1; break; }
        }
        if (!hit_tp1 && bar.high >= tp1) { hit_tp1 = true; tp1HitAt = barTime; }
        if (!hit_tp2 && bar.high >= tp2) { hit_tp2 = true; tp2HitAt = barTime; }
        if (!hit_tp3 && bar.high >= tp3) { hit_tp3 = true; tp3HitAt = barTime; }
      } else {
        const fav = entry - bar.low;
        const adv = bar.high - entry;
        if (fav > max_favorable) max_favorable = fav;
        if (adv > max_adverse) max_adverse = adv;

        if (!hit_sl && bar.high >= stop) {
          hit_sl = true;
          stoppedAt = barTime;
          if (!hit_tp1) { bars_to_resolution = i + 1; break; }
        }
        if (!hit_tp1 && bar.low <= tp1) { hit_tp1 = true; tp1HitAt = barTime; }
        if (!hit_tp2 && bar.low <= tp2) { hit_tp2 = true; tp2HitAt = barTime; }
        if (!hit_tp3 && bar.low <= tp3) { hit_tp3 = true; tp3HitAt = barTime; }
      }
      if (hit_tp3) { bars_to_resolution = i + 1; break; }
    }

    let outcome_r = 0;
    if (hit_tp3) outcome_r = 4.0;
    else if (hit_tp2) outcome_r = 2.5;
    else if (hit_tp1) outcome_r = 1.5;
    else if (hit_sl) outcome_r = -1;

    // Determine graded_outcome and resolution_path
    const { gradedOutcome, resolutionPath, resolvedAt } = deriveOutcome({
      hit_tp1, hit_tp2, hit_tp3, hit_sl,
      tp1HitAt, tp2HitAt, tp3HitAt, stoppedAt,
    });

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
      // Write lifecycle fields back to the decisions table (best-effort)
      await writeLifecycleToDecision(supabase, dec.id, {
        graded_outcome: gradedOutcome,
        resolution_path: resolutionPath,
        resolved_at: resolvedAt,
        tp1_hit_at: tp1HitAt,
        tp2_hit_at: tp2HitAt,
        tp3_hit_at: tp3HitAt,
        stopped_at: stoppedAt,
      });

      graded++;
      results.push({
        symbol: dec.symbol,
        decision: dec.decision,
        outcome_r: Math.round(outcome_r * 100) / 100,
        hit_tp1,
        graded_outcome: gradedOutcome,
      });
    }
  }

  return NextResponse.json({ status: "completed", checked: ungraded.length, graded, failed, results });
}

// ── Outcome derivation ───────────────────────────────────

interface OutcomeInput {
  hit_tp1: boolean;
  hit_tp2: boolean;
  hit_tp3: boolean;
  hit_sl: boolean;
  tp1HitAt: string | null;
  tp2HitAt: string | null;
  tp3HitAt: string | null;
  stoppedAt: string | null;
}

function deriveOutcome(input: OutcomeInput): {
  gradedOutcome: string;
  resolutionPath: string;
  resolvedAt: string | null;
} {
  const { hit_tp1, hit_tp2, hit_tp3, hit_sl, tp1HitAt, tp2HitAt, tp3HitAt, stoppedAt } = input;

  // Build path segments based on what was hit
  const pathParts = ["ENTRY"];

  if (hit_tp1) pathParts.push("TP1");
  if (hit_tp2) pathParts.push("TP2");
  if (hit_tp3) pathParts.push("TP3");

  // WIN_FULL: TP3 hit (full target completion)
  if (hit_tp3) {
    return {
      gradedOutcome: "WIN_FULL",
      resolutionPath: pathParts.join("->"),
      resolvedAt: tp3HitAt,
    };
  }

  // LOSS: stop hit before any TP
  if (hit_sl && !hit_tp1) {
    return {
      gradedOutcome: "LOSS",
      resolutionPath: "ENTRY->SL",
      resolvedAt: stoppedAt,
    };
  }

  // WIN_PARTIAL: at least TP1 hit, then stopped
  if (hit_sl && hit_tp1) {
    pathParts.push("SL");
    return {
      gradedOutcome: "WIN_PARTIAL",
      resolutionPath: pathParts.join("->"),
      resolvedAt: stoppedAt,
    };
  }

  // Still open or expired: TP hit(s) but no stop and no full win
  if (hit_tp1) {
    pathParts.push("EXPIRED");
    return {
      gradedOutcome: "WIN_PARTIAL",
      resolutionPath: pathParts.join("->"),
      resolvedAt: tp2HitAt ?? tp1HitAt,
    };
  }

  // Nothing hit within grading window
  return {
    gradedOutcome: "EXPIRED",
    resolutionPath: "ENTRY->EXPIRED",
    resolvedAt: null,
  };
}

// ── Helpers ──────────────────────────────────────────────

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

/**
 * Write lifecycle/grading fields back to the decisions table.
 *
 * OVERWRITE PROTECTION (first-hit semantics):
 *   - Reads existing lifecycle values before writing
 *   - Timestamps (tp1_hit_at, stopped_at, etc.) are only set if currently null
 *   - graded_outcome and resolution_path are only set if currently null
 *   - Once a decision is resolved, its lifecycle data is durable
 *   - This prevents re-grading from corrupting earlier truth
 *
 * Best-effort: if migration 014 columns don't exist, degrades silently.
 */
async function writeLifecycleToDecision(
  supabase: ReturnType<typeof getSupabase>,
  decisionId: string,
  fields: {
    graded_outcome: string;
    resolution_path: string;
    resolved_at: string | null;
    tp1_hit_at?: string | null;
    tp2_hit_at?: string | null;
    tp3_hit_at?: string | null;
    stopped_at?: string | null;
  }
) {
  // Read existing lifecycle values to enforce first-hit semantics
  const { data: existing, error: readErr } = await supabase
    .from("decisions")
    .select("graded_outcome, resolution_path, resolved_at, tp1_hit_at, tp2_hit_at, tp3_hit_at, stopped_at")
    .eq("id", decisionId)
    .maybeSingle();

  if (readErr) {
    if (readErr.message.includes("does not exist")) {
      console.warn("[grade-production] Lifecycle columns not available (migration 014 not applied)");
    } else {
      console.error(`[grade-production] Failed to read lifecycle for ${decisionId}:`, readErr.message);
    }
    return;
  }

  // Build update payload — only write fields that are currently null in the DB.
  // This ensures earlier grading truth is never overwritten by a re-grade.
  const update: Record<string, unknown> = {};

  if (!existing?.graded_outcome && fields.graded_outcome) {
    update.graded_outcome = fields.graded_outcome;
  }
  if (!existing?.resolution_path && fields.resolution_path) {
    update.resolution_path = fields.resolution_path;
  }
  if (!existing?.resolved_at && fields.resolved_at != null) {
    update.resolved_at = fields.resolved_at;
  }
  if (!existing?.tp1_hit_at && fields.tp1_hit_at != null) {
    update.tp1_hit_at = fields.tp1_hit_at;
  }
  if (!existing?.tp2_hit_at && fields.tp2_hit_at != null) {
    update.tp2_hit_at = fields.tp2_hit_at;
  }
  if (!existing?.tp3_hit_at && fields.tp3_hit_at != null) {
    update.tp3_hit_at = fields.tp3_hit_at;
  }
  if (!existing?.stopped_at && fields.stopped_at != null) {
    update.stopped_at = fields.stopped_at;
  }

  // Nothing to write — all fields already populated
  if (Object.keys(update).length === 0) {
    return;
  }

  const { error: writeErr } = await supabase
    .from("decisions")
    .update(update)
    .eq("id", decisionId);

  if (writeErr) {
    console.error(`[grade-production] Failed to write lifecycle for ${decisionId}:`, writeErr.message);
  }
}
