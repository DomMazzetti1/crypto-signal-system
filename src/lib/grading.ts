/**
 * Shared grading logic for production signals.
 *
 * Grades a single batch of up to `batchSize` eligible decisions (>48h old,
 * not yet graded). Returns the count of graded, failed, and remaining.
 *
 * Used by:
 *   - /api/shadow/grade-production (single batch, manual trigger)
 *   - /api/cron/grade (multi-batch loop, scheduled)
 */

import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";

const MIN_AGE_MS = 48 * 60 * 60 * 1000;
const FORWARD_BARS = 48;
const SLIPPAGE = 0.0005;
const TAKER_FEE = 0.00055;

export interface GradeBatchResult {
  checked: number;
  graded: number;
  failed: number;
  skipped: number;
  results: { symbol: string; decision: string; outcome_r: number; hit_tp1: boolean; graded_outcome: string }[];
}

export async function gradeBatch(batchSize = 50): Promise<GradeBatchResult> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();

  // AUDIT NOTE: "decision" column should only contain LONG, SHORT, or NO_TRADE.
  // MR_LONG, MR_SHORT, SQ_SHORT listed here are legacy values from early operation.
  // Run: SELECT DISTINCT decision FROM decisions; to confirm no unexpected values.
  const { data: decisions, error: decErr } = await supabase
    .from("decisions")
    .select("id, symbol, alert_type, decision, btc_regime, entry_price, stop_price, tp1_price, tp2_price, tp3_price, atr14_1h, created_at")
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT", "SQ_SHORT"])
    .lte("created_at", cutoff)
    .is("graded_outcome", null)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (decErr) throw new Error(`Failed to fetch decisions: ${decErr.message}`);
  if (!decisions || decisions.length === 0) {
    return { checked: 0, graded: 0, failed: 0, skipped: 0, results: [] };
  }

  const ungraded = decisions;

  let graded = 0;
  let failed = 0;
  const results: GradeBatchResult["results"] = [];

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

    let futureBars: Kline[];
    try {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${dec.symbol}&interval=60&start=${startAfter}&limit=${FORWARD_BARS}`;
      let res: Response;
      try {
        res = await fetch(url, { cache: "no-store" });
      } catch {
        await new Promise(r => setTimeout(r, 600));
        res = await fetch(url, { cache: "no-store" });
      }
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
      console.error(`[grading] Fetch error for ${dec.symbol}:`, err);
      await insertGrade(supabase, dec, "FAILED");
      failed++;
      continue;
    }

    if (futureBars.length < 10) continue;

    // Use stored levels — avoids future multiplier changes corrupting historical grades
    const rawRisk = Math.abs(entry - stop);
    if (rawRisk === 0) {
      await insertGrade(supabase, dec, "FAILED");
      await writeLifecycleToDecision(supabase, dec.id, {
        graded_outcome: "INVALID",
        resolution_path: "INVALID",
        resolved_at: new Date().toISOString(),
      });
      failed++;
      continue;
    }

    let tp1: number = Number.isFinite(Number(dec.tp1_price)) && Number(dec.tp1_price) > 0
      ? Number(dec.tp1_price)
      : isLong ? entry + rawRisk * 1.5 : entry - rawRisk * 1.5;
    let tp2: number = Number.isFinite(Number(dec.tp2_price)) && Number(dec.tp2_price) > 0
      ? Number(dec.tp2_price)
      : isLong ? entry + rawRisk * 2.5 : entry - rawRisk * 2.5;
    let tp3: number = Number.isFinite(Number(dec.tp3_price)) && Number(dec.tp3_price) > 0
      ? Number(dec.tp3_price)
      : isLong ? entry + rawRisk * 4.0 : entry - rawRisk * 4.0;

    // Apply friction model to match backtest/shadow grading methodology
    const fillEntry = isLong ? entry * (1 + SLIPPAGE) : entry * (1 - SLIPPAGE);
    const risk = Math.abs(fillEntry - stop);

    // Adjust TP levels for taker fees
    if (isLong) {
      tp1 = tp1 * (1 - TAKER_FEE);
      tp2 = tp2 * (1 - TAKER_FEE);
      tp3 = tp3 * (1 - TAKER_FEE);
    } else {
      tp1 = tp1 * (1 + TAKER_FEE);
      tp2 = tp2 * (1 + TAKER_FEE);
      tp3 = tp3 * (1 + TAKER_FEE);
    }

    let hit_tp1 = false, hit_tp2 = false, hit_tp3 = false, hit_sl = false;
    let max_favorable = 0, max_adverse = 0;
    let bars_to_resolution = futureBars.length;
    let tp1HitAt: string | null = null;
    let tp2HitAt: string | null = null;
    let tp3HitAt: string | null = null;
    let stoppedAt: string | null = null;

    for (let i = 0; i < futureBars.length; i++) {
      const bar = futureBars[i];
      const barTime = new Date(bar.startTime).toISOString();

      if (isLong) {
        const fav = bar.high - fillEntry;
        const adv = fillEntry - bar.low;
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
        const fav = fillEntry - bar.low;
        const adv = bar.high - fillEntry;
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
      entry_price: fillEntry,
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
      console.error(`[grading] Upsert failed for ${dec.symbol}:`, upsertErr);
      failed++;
    } else {
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

  return { checked: ungraded.length, graded, failed, skipped: 0, results };
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
  const pathParts = ["ENTRY"];

  if (hit_tp1) pathParts.push("TP1");
  if (hit_tp2) pathParts.push("TP2");
  if (hit_tp3) pathParts.push("TP3");

  if (hit_tp3) {
    return { gradedOutcome: "WIN_FULL", resolutionPath: pathParts.join("->"), resolvedAt: tp3HitAt };
  }
  if (hit_sl && !hit_tp1) {
    return { gradedOutcome: "LOSS", resolutionPath: "ENTRY->SL", resolvedAt: stoppedAt };
  }
  if (hit_sl && hit_tp1) {
    pathParts.push("SL");
    // TP1 hit then stopped out — partial win but position ultimately closed at loss
    return { gradedOutcome: "WIN_PARTIAL_THEN_SL", resolutionPath: pathParts.join("->"), resolvedAt: stoppedAt };
  }
  if (hit_tp1) {
    pathParts.push("EXPIRED");
    // TP1 hit, no SL, but expired before TP2 — partial win with open question
    return { gradedOutcome: "WIN_PARTIAL_EXPIRED", resolutionPath: pathParts.join("->"), resolvedAt: tp2HitAt ?? tp1HitAt };
  }
  return { gradedOutcome: "EXPIRED", resolutionPath: "ENTRY->EXPIRED", resolvedAt: null };
}

// ── Helpers ──────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof getSupabase>;

async function insertGrade(
  supabase: SupabaseClient,
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

async function writeLifecycleToDecision(
  supabase: SupabaseClient,
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
  const { data: existing, error: readErr } = await supabase
    .from("decisions")
    .select("graded_outcome, resolution_path, resolved_at, tp1_hit_at, tp2_hit_at, tp3_hit_at, stopped_at")
    .eq("id", decisionId)
    .maybeSingle();

  if (readErr) {
    if (readErr.message.includes("does not exist")) {
      console.warn("[grading] Lifecycle columns not available (migration 014 not applied)");
    } else {
      console.error(`[grading] Failed to read lifecycle for ${decisionId}:`, readErr.message);
    }
    return;
  }

  const update: Record<string, unknown> = {};
  if (!existing?.graded_outcome && fields.graded_outcome) update.graded_outcome = fields.graded_outcome;
  if (!existing?.resolution_path && fields.resolution_path) update.resolution_path = fields.resolution_path;
  if (!existing?.resolved_at && fields.resolved_at != null) update.resolved_at = fields.resolved_at;
  if (!existing?.tp1_hit_at && fields.tp1_hit_at != null) update.tp1_hit_at = fields.tp1_hit_at;
  if (!existing?.tp2_hit_at && fields.tp2_hit_at != null) update.tp2_hit_at = fields.tp2_hit_at;
  if (!existing?.tp3_hit_at && fields.tp3_hit_at != null) update.tp3_hit_at = fields.tp3_hit_at;
  if (!existing?.stopped_at && fields.stopped_at != null) update.stopped_at = fields.stopped_at;

  if (Object.keys(update).length === 0) return;

  const { error: writeErr } = await supabase.from("decisions").update(update).eq("id", decisionId);
  if (writeErr) {
    console.error(`[grading] Failed to write lifecycle for ${decisionId}:`, writeErr.message);
  }
}
