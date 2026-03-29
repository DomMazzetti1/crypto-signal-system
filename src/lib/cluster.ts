/**
 * Cluster Assignment and Execution Selection (v2 — score-based)
 *
 * Cluster definition:
 *   Signals are clustered by: same hour bucket + same direction + same regime.
 *   cluster_id = "{YYYY-MM-DDTHH}:{LONG|SHORT}:{regime}"
 *   cluster_hour = created_at truncated to the hour
 *
 * Selection window:
 *   Selection is DEFERRED for CLUSTER_SELECTION_WINDOW_MS (60s) after the first
 *   signal in a cluster arrives. During this window, signals accumulate with
 *   selected_for_execution = false, suppressed_reason = null (pending state).
 *
 *   After the window expires, the cluster is finalized lazily — triggered by:
 *     - a new pipeline signal arriving (post-store check)
 *     - a dashboard/API read (active-signals route)
 *     - a grading job touching the cluster
 *
 * Finalized ranking:
 *   1. composite_score DESC
 *   2. rr_tp1 DESC
 *   Rank 1 = best signal in cluster.
 *
 * Finalized execution selection policy:
 *   - STRICT has priority over RELAXED regardless of score
 *   - Among eligible STRICT signals, highest composite_score wins
 *   - If no STRICT, among eligible RELAXED signals, highest composite_score wins
 *   - Maximum 1 signal selected per cluster
 *   - All others get suppressed_reason = "LOWER_SCORE_IN_CLUSTER"
 *   - DATA_ONLY is never selected (immediate, not deferred)
 *   - Cooldown-active signals are not selected (immediate, not deferred)
 *
 * Suppressed reason values:
 *   - LOWER_SCORE_IN_CLUSTER (score-based finalization)
 *   - CLUSTER_ALREADY_FINALIZED (late arrival after window)
 *   - DATA_ONLY_NON_EXECUTABLE (immediate)
 *   - COOLDOWN_ACTIVE (immediate)
 *
 * No-selection-pending derivation:
 *   A signal is "pending" if: cluster_id IS NOT NULL AND selected_for_execution = false
 *   AND suppressed_reason IS NULL. No extra schema columns needed.
 *
 * Migration resilience:
 *   If migration 014 has not been applied, cluster queries fail gracefully.
 *   The signal proceeds with rank=1, selected=true (solo, immediate).
 */

import { getSupabase } from "@/lib/supabase";

/** Selection window: 60 seconds from first signal in cluster */
export const CLUSTER_SELECTION_WINDOW_MS = 60_000;

export interface ClusterInput {
  symbol: string;
  decision: string; // "LONG" | "SHORT"
  alert_type: string;
  btc_regime: string;
  created_at: Date;
  composite_score: number;
  rr_tp1: number;
  cooldown_active: boolean;
}

export interface ClusterResult {
  cluster_id: string;
  cluster_hour: string; // ISO timestamp truncated to hour
  cluster_size: number;
  cluster_rank: number;
  selected_for_execution: boolean;
  suppressed_reason: string | null;
}

function truncateToHour(d: Date): Date {
  const t = new Date(d);
  t.setMinutes(0, 0, 0);
  return t;
}

export function deriveTier(alertType: string): "STRICT" | "RELAXED" | "DATA_ONLY" {
  const upper = alertType.toUpperCase();
  if (upper.includes("_DATA")) return "DATA_ONLY";
  if (upper.includes("_RELAXED")) return "RELAXED";
  return "STRICT";
}

export function buildClusterId(
  hourBucket: Date,
  direction: string,
  regime: string
): string {
  const hourKey = hourBucket.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  return `${hourKey}:${direction}:${regime}`;
}

/**
 * Assigns cluster metadata for a new signal. Selection is DEFERRED unless:
 * - The signal is DATA_ONLY or cooldown-active (immediate suppression)
 * - The cluster is already finalized (late arrival — immediate suppression)
 * - Pre-migration fallback (solo signal, immediate selection)
 */
export async function assignCluster(
  input: ClusterInput
): Promise<ClusterResult> {
  const hourBucket = truncateToHour(input.created_at);
  const clusterId = buildClusterId(hourBucket, input.decision, input.btc_regime);
  const clusterHour = hourBucket.toISOString();
  const tier = deriveTier(input.alert_type);

  // DATA_ONLY is never selected — immediate, skip DB query
  if (tier === "DATA_ONLY") {
    return {
      cluster_id: clusterId,
      cluster_hour: clusterHour,
      cluster_size: 1,
      cluster_rank: 1,
      selected_for_execution: false,
      suppressed_reason: "DATA_ONLY_NON_EXECUTABLE",
    };
  }

  if (input.cooldown_active) {
    return {
      cluster_id: clusterId,
      cluster_hour: clusterHour,
      cluster_size: 1,
      cluster_rank: 1,
      selected_for_execution: false,
      suppressed_reason: "COOLDOWN_ACTIVE",
    };
  }

  // Fetch existing decisions in this cluster.
  const supabase = getSupabase();
  let clusterMembers: {
    id: string;
    composite_score: unknown;
    rr_tp1: unknown;
    alert_type: string;
    selected_for_execution: unknown;
    suppressed_reason: unknown;
    created_at: string;
  }[] = [];

  const { data: existing, error: clusterErr } = await supabase
    .from("decisions")
    .select("id, composite_score, rr_tp1, alert_type, selected_for_execution, suppressed_reason, created_at")
    .eq("cluster_id", clusterId)
    .in("decision", ["LONG", "SHORT"])
    .order("created_at", { ascending: true });

  if (clusterErr) {
    // Column doesn't exist (pre-migration) — proceed as solo, selected
    console.warn("[cluster] Cluster query failed (migration 014 not applied?), proceeding as new cluster");
    return {
      cluster_id: clusterId,
      cluster_hour: clusterHour,
      cluster_size: 1,
      cluster_rank: 1,
      selected_for_execution: true,
      suppressed_reason: null,
    };
  } else {
    clusterMembers = existing ?? [];
  }

  const clusterSize = clusterMembers.length + 1;

  // Provisional rank: count how many existing members have a higher score
  let rank = 1;
  for (const m of clusterMembers) {
    const mScore = Number(m.composite_score) || 0;
    const mRr = Number(m.rr_tp1) || 0;
    if (
      mScore > input.composite_score ||
      (mScore === input.composite_score && mRr > input.rr_tp1)
    ) {
      rank++;
    }
  }

  // Check if cluster is already finalized (any member has been selected)
  const isFinalized = clusterMembers.some(
    (m) => m.selected_for_execution === true
  );

  // Update cluster_size on existing members (best-effort, non-blocking)
  if (clusterMembers.length > 0) {
    const ids = clusterMembers.map((m) => m.id);
    supabase
      .from("decisions")
      .update({ cluster_size: clusterSize })
      .in("id", ids)
      .then(({ error: updateErr }) => {
        if (updateErr) console.warn("[cluster] cluster_size update failed:", updateErr.message);
      });
  }

  if (isFinalized) {
    // Late arrival into finalized cluster — immediate suppression
    return {
      cluster_id: clusterId,
      cluster_hour: clusterHour,
      cluster_size: clusterSize,
      cluster_rank: rank,
      selected_for_execution: false,
      suppressed_reason: "CLUSTER_ALREADY_FINALIZED",
    };
  }

  // Cluster not finalized — defer selection (pending state)
  // pending = selected_for_execution=false AND suppressed_reason=null
  return {
    cluster_id: clusterId,
    cluster_hour: clusterHour,
    cluster_size: clusterSize,
    cluster_rank: rank,
    selected_for_execution: false,
    suppressed_reason: null,
  };
}

/**
 * Finalizes selection for a single cluster. Called lazily when the selection
 * window has expired. Picks the highest-scoring eligible signal.
 *
 * Returns true if finalization occurred, false if skipped (already finalized,
 * window still open, or error).
 */
export async function finalizeClusterSelection(clusterId: string): Promise<boolean> {
  const supabase = getSupabase();

  const { data: members, error } = await supabase
    .from("decisions")
    .select("id, composite_score, rr_tp1, alert_type, cooldown_active, selected_for_execution, suppressed_reason, created_at")
    .eq("cluster_id", clusterId)
    .in("decision", ["LONG", "SHORT"])
    .order("created_at", { ascending: true });

  if (error || !members || members.length === 0) return false;

  // Already finalized? (any member has been selected)
  if (members.some((m) => m.selected_for_execution === true)) return false;

  // Check if ALL eligible members have suppressed_reason set (no pending signals)
  const hasPending = members.some(
    (m) => m.selected_for_execution === false && m.suppressed_reason == null
  );
  if (!hasPending) return false;

  // Check window: has CLUSTER_SELECTION_WINDOW_MS passed since first signal?
  const firstCreatedAt = new Date(members[0].created_at).getTime();
  if (Date.now() - firstCreatedAt < CLUSTER_SELECTION_WINDOW_MS) return false;

  const clusterSize = members.length;

  // Rank all members by composite_score DESC, rr_tp1 DESC
  const ranked = [...members].sort((a, b) => {
    const scoreA = Number(a.composite_score) || 0;
    const scoreB = Number(b.composite_score) || 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    const rrA = Number(a.rr_tp1) || 0;
    const rrB = Number(b.rr_tp1) || 0;
    return rrB - rrA;
  });

  // Determine winner: STRICT priority over RELAXED, then highest score
  const eligible = ranked.filter((m) => {
    const tier = deriveTier(m.alert_type);
    return tier !== "DATA_ONLY" && !m.cooldown_active;
  });

  const strictCandidates = eligible.filter((m) => deriveTier(m.alert_type) === "STRICT");
  const relaxedCandidates = eligible.filter((m) => deriveTier(m.alert_type) === "RELAXED");

  let selectedId: string | null = null;
  if (strictCandidates.length > 0) {
    selectedId = strictCandidates[0].id; // highest-scoring STRICT
  } else if (relaxedCandidates.length > 0) {
    selectedId = relaxedCandidates[0].id; // highest-scoring RELAXED
  }

  // Update all members with final selection state
  const updates = ranked.map((m, i) => {
    const rank = i + 1;
    const tier = deriveTier(m.alert_type);
    const isSelected = m.id === selectedId;

    let suppressedReason: string | null = null;
    if (!isSelected) {
      if (tier === "DATA_ONLY") {
        suppressedReason = "DATA_ONLY_NON_EXECUTABLE";
      } else if (m.cooldown_active) {
        suppressedReason = "COOLDOWN_ACTIVE";
      } else {
        suppressedReason = "LOWER_SCORE_IN_CLUSTER";
      }
    }

    return {
      id: m.id,
      selected_for_execution: isSelected,
      suppressed_reason: suppressedReason,
      cluster_rank: rank,
      cluster_size: clusterSize,
    };
  });

  // Apply updates (parallel, best-effort)
  await Promise.all(
    updates.map((u) =>
      supabase
        .from("decisions")
        .update({
          selected_for_execution: u.selected_for_execution,
          suppressed_reason: u.suppressed_reason,
          cluster_rank: u.cluster_rank,
          cluster_size: u.cluster_size,
        })
        .eq("id", u.id)
        .then(({ error: updateErr }) => {
          if (updateErr) console.warn(`[cluster] finalize update failed for ${u.id}:`, updateErr.message);
        })
    )
  );

  console.log(
    `[cluster] Finalized ${clusterId}: ${members.length} members, selected=${selectedId}, ` +
    `top_score=${Number(ranked[0]?.composite_score) || 0}`
  );

  return true;
}

/**
 * Finds and finalizes all clusters with expired selection windows.
 * Called by dashboard/API routes before returning data.
 * Returns the number of clusters finalized.
 */
export async function finalizeExpiredClusters(): Promise<number> {
  const supabase = getSupabase();
  const windowCutoff = new Date(Date.now() - CLUSTER_SELECTION_WINDOW_MS).toISOString();

  // Find pending signals: cluster_id set, no selection state, window expired
  const { data: pending, error } = await supabase
    .from("decisions")
    .select("cluster_id")
    .not("cluster_id", "is", null)
    .in("decision", ["LONG", "SHORT"])
    .eq("selected_for_execution", false)
    .is("suppressed_reason", null)
    .lte("created_at", windowCutoff);

  if (error) {
    // Migration 014 not applied or query issue — skip silently
    if (!error.message.includes("does not exist")) {
      console.warn("[cluster] finalizeExpiredClusters query failed:", error.message);
    }
    return 0;
  }

  if (!pending || pending.length === 0) return 0;

  // Get unique cluster_ids
  const clusterIds = Array.from(new Set(pending.map((p) => p.cluster_id as string)));

  let finalized = 0;
  for (const cid of clusterIds) {
    const ok = await finalizeClusterSelection(cid);
    if (ok) finalized++;
  }

  if (finalized > 0) {
    console.log(`[cluster] finalizeExpiredClusters: finalized ${finalized} cluster(s)`);
  }

  return finalized;
}
