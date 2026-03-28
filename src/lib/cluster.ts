/**
 * Cluster Assignment and Execution Selection
 *
 * Cluster definition:
 *   Signals are clustered by: same hour bucket + same direction + same regime.
 *   cluster_id = "{YYYY-MM-DDTHH}:{LONG|SHORT}:{regime}"
 *   cluster_hour = created_at truncated to the hour
 *
 * Ranking within cluster:
 *   1. composite_score DESC
 *   2. rr_tp1 DESC
 *   3. created_at ASC (newer = higher rank as tiebreak)
 *   Rank 1 = best signal in cluster.
 *
 * Execution selection policy:
 *   - Maximum 1 STRICT signal selected per cluster
 *   - If a STRICT is already selected, suppress all RELAXED in that cluster
 *   - If no STRICT selected, allow maximum 1 RELAXED in that cluster
 *   - DATA_ONLY is never selected for execution
 *   - Cooldown-active signals are not selected
 *   - Signals with invalid levels (decision=NO_TRADE) never reach this
 *
 * Suppressed reason values:
 *   - STRICT_ALREADY_SELECTED_IN_CLUSTER
 *   - RELAXED_ALREADY_SELECTED_IN_CLUSTER
 *   - DATA_ONLY_NON_EXECUTABLE
 *   - COOLDOWN_ACTIVE
 *   - INVALID_LEVELS (set upstream, not here)
 */

import { getSupabase } from "@/lib/supabase";

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

function deriveTier(alertType: string): "STRICT" | "RELAXED" | "DATA_ONLY" {
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
 * Assigns cluster metadata and determines execution selection for a new signal.
 * Queries existing cluster members to determine rank and selection eligibility.
 */
export async function assignCluster(
  input: ClusterInput
): Promise<ClusterResult> {
  const hourBucket = truncateToHour(input.created_at);
  const clusterId = buildClusterId(hourBucket, input.decision, input.btc_regime);
  const clusterHour = hourBucket.toISOString();
  const tier = deriveTier(input.alert_type);

  // DATA_ONLY is never selected — skip DB query
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

  // Fetch existing decisions in this cluster
  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from("decisions")
    .select("id, composite_score, rr_tp1, alert_type, selected_for_execution, created_at")
    .eq("cluster_id", clusterId)
    .in("decision", ["LONG", "SHORT"])
    .order("composite_score", { ascending: false });

  const clusterMembers = existing ?? [];
  const clusterSize = clusterMembers.length + 1; // including this new signal

  // Determine rank: count how many existing members have a higher score
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

  // Execution selection policy
  const hasSelectedStrict = clusterMembers.some(
    (m) => m.selected_for_execution && deriveTier(m.alert_type) === "STRICT"
  );
  const hasSelectedRelaxed = clusterMembers.some(
    (m) => m.selected_for_execution && deriveTier(m.alert_type) === "RELAXED"
  );

  let selected = false;
  let suppressedReason: string | null = null;

  if (tier === "STRICT") {
    if (hasSelectedStrict) {
      suppressedReason = "STRICT_ALREADY_SELECTED_IN_CLUSTER";
    } else {
      selected = true;
    }
  } else {
    // RELAXED
    if (hasSelectedStrict) {
      suppressedReason = "STRICT_ALREADY_SELECTED_IN_CLUSTER";
    } else if (hasSelectedRelaxed) {
      suppressedReason = "RELAXED_ALREADY_SELECTED_IN_CLUSTER";
    } else {
      selected = true;
    }
  }

  // Update cluster_size on existing members (lightweight indexed update)
  if (clusterMembers.length > 0) {
    const ids = clusterMembers.map((m) => m.id);
    await supabase
      .from("decisions")
      .update({ cluster_size: clusterSize })
      .in("id", ids);
  }

  return {
    cluster_id: clusterId,
    cluster_hour: clusterHour,
    cluster_size: clusterSize,
    cluster_rank: rank,
    selected_for_execution: selected,
    suppressed_reason: suppressedReason,
  };
}
