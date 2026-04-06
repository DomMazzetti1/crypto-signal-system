import { estimateLadderR, isPositiveOutcome } from "@/lib/outcome-estimates";

export interface StrategyAuditRow {
  alert_type: string;
  decision: string;
  btc_regime: string | null;
  graded_outcome: string | null;
  resolution_path: string | null;
  telegram_sent: boolean | null;
  selected_for_execution: boolean | null;
  suppressed_reason: string | null;
  blocked_reason: string | null;
}

export interface StrategyAuditBucket {
  key: string;
  label: string;
  total_signals: number;
  resolved_signals: number;
  open_signals: number;
  wins: number;
  losses: number;
  neutral: number;
  win_rate: number | null;
  avg_r: number | null;
  total_r: number;
  profit_factor: number | null;
}

interface BucketDefinition {
  key: string;
  label: string;
  match: (row: StrategyAuditRow) => boolean;
}

const NON_COMPARISON_OUTCOMES = new Set(["INVALID", "CANCELLED", "STALE_ENTRY"]);

function normalizeSetupFamily(alertType: string): string {
  return alertType.replace(/_RELAXED$|_DATA$/i, "");
}

function buildBucket(
  key: string,
  label: string,
  rows: StrategyAuditRow[]
): StrategyAuditBucket {
  const resolved = rows.filter(
    (row) => row.graded_outcome != null && !NON_COMPARISON_OUTCOMES.has(row.graded_outcome)
  );

  const estimates = resolved.map((row) => ({
    r: estimateLadderR(row.graded_outcome, row.resolution_path),
    positive: isPositiveOutcome(row.graded_outcome, row.resolution_path),
  }));

  const wins = estimates.filter((estimate) => estimate.positive).length;
  const losses = estimates.filter((estimate) => estimate.r < 0).length;
  const neutral = estimates.length - wins - losses;
  const totalR = estimates.reduce((sum, estimate) => sum + estimate.r, 0);
  const avgR = estimates.length > 0 ? totalR / estimates.length : null;
  const totalWinR = estimates.reduce((sum, estimate) => sum + Math.max(estimate.r, 0), 0);
  const totalLossR = estimates.reduce((sum, estimate) => sum + Math.abs(Math.min(estimate.r, 0)), 0);

  return {
    key,
    label,
    total_signals: rows.length,
    resolved_signals: resolved.length,
    open_signals: rows.length - resolved.length,
    wins,
    losses,
    neutral,
    win_rate: resolved.length > 0 ? Math.round((wins / resolved.length) * 1000) / 10 : null,
    avg_r: avgR != null ? Math.round(avgR * 100) / 100 : null,
    total_r: Math.round(totalR * 100) / 100,
    profit_factor:
      totalLossR > 0
        ? Math.round((totalWinR / totalLossR) * 100) / 100
        : wins > 0
          ? Number.POSITIVE_INFINITY
          : null,
  };
}

export function computeStrategyAudit(rows: StrategyAuditRow[]) {
  const enriched = rows.map((row) => ({
    ...row,
    setup_family: normalizeSetupFamily(row.alert_type),
  }));

  const priorityDefinitions: BucketDefinition[] = [
    {
      key: "sq_short_bear",
      label: "SQ_SHORT / bear",
      match: (row) => normalizeSetupFamily(row.alert_type) === "SQ_SHORT" && row.btc_regime === "bear",
    },
    {
      key: "sq_short_bull",
      label: "SQ_SHORT / bull",
      match: (row) => normalizeSetupFamily(row.alert_type) === "SQ_SHORT" && row.btc_regime === "bull",
    },
    {
      key: "sq_long_reversal_sideways",
      label: "SQ_LONG_REVERSAL / sideways",
      match: (row) =>
        normalizeSetupFamily(row.alert_type) === "SQ_LONG_REVERSAL" && row.btc_regime === "sideways",
    },
    {
      key: "mr_short_bear",
      label: "MR_SHORT / bear",
      match: (row) => normalizeSetupFamily(row.alert_type) === "MR_SHORT" && row.btc_regime === "bear",
    },
    {
      key: "mr_long_sideways",
      label: "MR_LONG / sideways",
      match: (row) => normalizeSetupFamily(row.alert_type) === "MR_LONG" && row.btc_regime === "sideways",
    },
  ];

  const deliveryDefinitions: BucketDefinition[] = [
    {
      key: "auto_exec",
      label: "Auto-exec eligible",
      match: (row) => row.selected_for_execution === true && row.telegram_sent === true,
    },
    {
      key: "manual_telegram",
      label: "Manual via Telegram",
      match: (row) => row.telegram_sent === true && row.selected_for_execution !== true,
    },
    {
      key: "telegram_blocked",
      label: "Blocked before Telegram",
      match: (row) => row.telegram_sent !== true && Boolean(row.blocked_reason),
    },
    {
      key: "cluster_suppressed",
      label: "Cluster suppressed",
      match: (row) => row.suppressed_reason != null,
    },
  ];

  const matrixRows = Array.from(
    enriched.reduce((map, row) => {
      const key = `${row.setup_family}|${row.btc_regime ?? "unknown"}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: `${row.setup_family} / ${row.btc_regime ?? "unknown"}`,
          rows: [] as StrategyAuditRow[],
        });
      }
      map.get(key)!.rows.push(row);
      return map;
    }, new Map<string, { key: string; label: string; rows: StrategyAuditRow[] }>())
  )
    .map(([, value]) => buildBucket(value.key, value.label, value.rows))
    .sort((a, b) => b.total_signals - a.total_signals);

  return {
    totals: buildBucket("all", "All resolved trade decisions", rows),
    priority_slices: priorityDefinitions.map((definition) =>
      buildBucket(definition.key, definition.label, rows.filter(definition.match))
    ),
    delivery_modes: deliveryDefinitions.map((definition) =>
      buildBucket(definition.key, definition.label, rows.filter(definition.match))
    ),
    strategy_regime_matrix: matrixRows,
  };
}
