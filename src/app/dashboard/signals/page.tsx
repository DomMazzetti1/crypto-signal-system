"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────

type Signal = {
  id: string;
  symbol: string;
  decision: string;
  alert_type: string;
  setup_family: string;
  tier: string;
  alert_tf: string;
  created_at: string;
  entry_price: number | null;
  stop_price: number | null;
  tp1_price: number | null;
  tp2_price: number | null;
  tp3_price: number | null;
  rr_tp1: number | null;
  current_price: number | null;
  status: string;
  live_status: string;
  live_tp1_hit: boolean;
  live_tp2_hit: boolean;
  live_tp3_hit: boolean;
  live_stop_hit: boolean;
  pct_to_tp1: number | null;
  score: number;
  cluster_id: string | null;
  cluster_size: number;
  cluster_rank: number | null;
  selected_for_execution: boolean;
  suppressed_reason: string | null;
  selection_pending: boolean;
  // graded_outcome is persisted research truth, separate from live status.
  // Live status (OPEN/TP1_HIT/STOPPED/etc.) is derived from current price.
  // graded_outcome (WIN_FULL/LOSS/etc.) is set by the grading job and is durable.
  graded_outcome: string | null;
  tp1_hit_at: string | null;
  tp2_hit_at: string | null;
  tp3_hit_at: string | null;
  stopped_at: string | null;
  resolved_at: string | null;
  telegram_sent: boolean;
  telegram_attempted: boolean;
  telegram_error?: string | null;
  blocked_reason: string | null;
  btc_regime?: string | null;
  gate_a_quality: string | null;
  gate_b_passed: boolean;
  gate_b_reason?: string | null;
};

type Filters = {
  hours: number;
  tier: string;
  statusFilter: string;
};

type Cluster = {
  key: string;
  label: string;
  signals: Signal[];
  total: number;
  open: number;
  tp1: number;
  tp2: number;
  tp3: number;
  stopped: number;
  selected: number;
  suppressed: number;
  pending: number;
};

// ── Helpers ────────────────────────────────────────────

function tradingViewUrl(symbol: string): string {
  const clean = symbol.replace(/USDT$/i, "");
  return `https://www.tradingview.com/chart/?symbol=BYBIT%3A${clean}USDT.P`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ${diffMin % 60}m ago`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatPrice(val: number | null): string {
  if (val == null) return "-";
  if (!Number.isFinite(val)) return "-";
  if (val >= 1000) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);
  return val.toPrecision(4);
}

function fmtEnumLabel(value: string | null | undefined): string {
  if (!value) return "--";
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function gradedColor(outcome: string | null): string {
  if (!outcome) return "text-neutral-600";
  if (outcome.startsWith("WIN")) return "text-emerald-400";
  if (outcome === "LOSS") return "text-red-400";
  return "text-yellow-400";
}

function clusterKey(signal: Signal): string {
  if (signal.cluster_id) return signal.cluster_id;
  const d = new Date(signal.created_at);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

function clusterLabel(key: string): string {
  const hourPart = key.slice(0, 13);
  const rest = key.slice(14);
  const d = new Date(hourPart + ":00:00.000Z");
  if (isNaN(d.getTime())) return key;
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return rest ? `${time} ${rest}` : time;
}

function positionRef(signal: Signal): string {
  if (
    signal.entry_price == null ||
    signal.tp1_price == null ||
    signal.entry_price === 0
  )
    return "-";
  const pctMove =
    Math.abs(signal.tp1_price - signal.entry_price) / signal.entry_price;
  if (!Number.isFinite(pctMove)) return "-";
  const returnPct = pctMove * 10 * 100;
  return `+${returnPct.toFixed(1)}%`;
}

function matchesStatus(signal: Signal, filter: string): boolean {
  const st = signal.live_status ?? signal.status;
  switch (filter) {
    case "open":
      return st === "OPEN";
    case "tp_hits":
      return st.startsWith("TP");
    case "stopped":
      return st === "STOPPED";
    default:
      return true;
  }
}

function scoreColor(score: number): string {
  if (!Number.isFinite(score) || score <= 0) return "text-neutral-600";
  if (score >= 70) return "text-emerald-400";
  if (score >= 50) return "text-yellow-400";
  if (score >= 30) return "text-orange-400";
  return "text-red-400";
}

function prettifyReason(reason: string | null | undefined): string {
  if (!reason) return "-";
  return reason.replace(/_/g, " ");
}

function operatorReason(signal: Signal): string {
  if (signal.selection_pending) return "Cluster window still open";
  if (signal.blocked_reason) return prettifyReason(signal.blocked_reason);
  if (signal.telegram_sent) {
    return signal.selected_for_execution
      ? "Telegram sent, auto-exec eligible"
      : "Telegram sent, manual-only";
  }
  if (signal.telegram_attempted) {
    return signal.telegram_error
      ? `Telegram failed: ${signal.telegram_error}`
      : "Telegram attempted but not sent";
  }
  if (signal.suppressed_reason) {
    return `Cluster suppressed: ${prettifyReason(signal.suppressed_reason)}`;
  }
  if (!signal.gate_b_passed) {
    return signal.gate_b_reason
      ? `Gate B failed: ${prettifyReason(signal.gate_b_reason)}`
      : "Gate B failed";
  }
  if (signal.selected_for_execution) return "Selected for execution";
  return "Waiting on downstream delivery";
}

function operatorBadge(signal: Signal): {
  label: string;
  className: string;
  title: string;
} {
  if (signal.selection_pending) {
    return {
      label: "Pending",
      className: "text-yellow-400 bg-yellow-500/10 border border-yellow-500/20",
      title: "Cluster window still open",
    };
  }
  if (signal.blocked_reason) {
    return {
      label: "Blocked",
      className: "text-red-300 bg-red-500/10 border border-red-500/20",
      title: operatorReason(signal),
    };
  }
  if (signal.telegram_sent && signal.selected_for_execution) {
    return {
      label: "Auto",
      className: "text-cyan-300 bg-cyan-500/10 border border-cyan-500/20",
      title: operatorReason(signal),
    };
  }
  if (signal.telegram_sent) {
    return {
      label: "Manual",
      className: "text-emerald-300 bg-emerald-500/10 border border-emerald-500/20",
      title: operatorReason(signal),
    };
  }
  if (signal.telegram_attempted) {
    return {
      label: "Error",
      className: "text-red-300 bg-red-500/10 border border-red-500/20",
      title: operatorReason(signal),
    };
  }
  if (signal.suppressed_reason) {
    return {
      label: "Suppressed",
      className: "text-neutral-300 bg-white/5 border border-white/10",
      title: operatorReason(signal),
    };
  }
  if (!signal.gate_b_passed) {
    return {
      label: "Gate B",
      className: "text-red-300 bg-red-500/10 border border-red-500/20",
      title: operatorReason(signal),
    };
  }
  return {
    label: "Queued",
    className: "text-neutral-300 bg-white/5 border border-white/10",
    title: operatorReason(signal),
  };
}

// ── Constants ──────────────────────────────────────────

const HOUR_OPTIONS = [4, 12, 24] as const;
const STATUS_OPTIONS = [
  { value: "open", label: "Open Only" },
  { value: "all", label: "All" },
  { value: "tp_hits", label: "TP Hits" },
  { value: "stopped", label: "Stopped" },
] as const;

const COL_SPAN = 15;

// ── Selection stats type ───────────────────────────────

type SelectionStats = {
  schema_available: boolean;
  total_resolved?: number;
  total_unresolved?: number;
  comparison_eligible?: number;
  comparison_excluded_untagged?: number;
  win_rate_definition?: string;
  by_selection?: {
    selected: { total: number; win_full: number; win_partial: number; loss: number; win_rate: number | null; eligible_for_rate: number };
    suppressed: { total: number; win_full: number; win_partial: number; loss: number; win_rate: number | null; eligible_for_rate: number };
  };
};

type StrategyAuditBucket = {
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
};

type StrategyAudit = {
  schema_available: boolean;
  generated_at?: string;
  days?: number;
  totals?: StrategyAuditBucket;
  priority_slices?: StrategyAuditBucket[];
  delivery_modes?: StrategyAuditBucket[];
  strategy_regime_matrix?: StrategyAuditBucket[];
  message?: string;
};

// ── Component ──────────────────────────────────────────

export default function SignalsDashboard() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pricesLoaded, setPricesLoaded] = useState(false);
  const [priceSource, setPriceSource] = useState<string>("none");
  const [schemaVersion, setSchemaVersion] = useState<string>("unknown");
  const [selectionStats, setSelectionStats] = useState<SelectionStats | null>(null);
  const [strategyAudit, setStrategyAudit] = useState<StrategyAudit | null>(null);
  const [filters, setFilters] = useState<Filters>({
    hours: 4,
    tier: "all",
    statusFilter: "open",
  });

  const isDegraded = schemaVersion === "base";
  const controlsRef = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);

  useEffect(() => {
    function measure() {
      if (controlsRef.current) {
        setControlsHeight(controlsRef.current.offsetHeight);
      }
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isDegraded, selectionStats]);

  const fetchSignals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ hours: String(filters.hours) });
      if (filters.tier !== "all") params.set("tier", filters.tier);
      const res = await fetch(`/api/dashboard/active-signals?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSignals(json.signals ?? []);
      setPricesLoaded(json.prices_loaded ?? false);
      setPriceSource(json.price_source ?? "none");
      setSchemaVersion(json.schema_version ?? "unknown");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetch("/api/dashboard/selection-stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setSelectionStats(d);
      })
      .catch(() => {});

    fetch("/api/dashboard/strategy-audit?days=90")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setStrategyAudit(d);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 30_000);
    return () => clearInterval(interval);
  }, [fetchSignals]);

  const filtered = useMemo(() => {
    return signals
      .filter((s) => matchesStatus(s, filters.statusFilter))
      .sort((a, b) => {
        const scoreDiff = (b.score || 0) - (a.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return (a.cluster_rank ?? 999) - (b.cluster_rank ?? 999);
      });
  }, [signals, filters.statusFilter]);

  const clusters = useMemo(() => {
    const map = new Map<string, Signal[]>();
    for (const s of filtered) {
      const key = clusterKey(s);
      const arr = map.get(key);
      if (arr) arr.push(s);
      else map.set(key, [s]);
    }
    const result: Cluster[] = [];
    for (const [key, sigs] of Array.from(map.entries())) {
      result.push({
        key,
        label: clusterLabel(key),
        signals: sigs,
        total: sigs.length,
        open: sigs.filter((s) => (s.live_status ?? s.status) === "OPEN").length,
        tp1: sigs.filter((s) => (s.live_status ?? s.status) === "TP1_HIT").length,
        tp2: sigs.filter((s) => (s.live_status ?? s.status) === "TP2_HIT").length,
        tp3: sigs.filter((s) => (s.live_status ?? s.status) === "TP3_HIT").length,
        stopped: sigs.filter((s) => (s.live_status ?? s.status) === "STOPPED").length,
        selected: sigs.filter((s) => s.selected_for_execution).length,
        suppressed: sigs.filter((s) => s.suppressed_reason != null).length,
        pending: sigs.filter((s) => s.selection_pending).length,
      });
    }
    result.sort((a, b) => b.key.localeCompare(a.key));
    return result;
  }, [filtered]);

  return (
    <div className="min-h-screen bg-black text-white p-6 font-[family-name:var(--font-geist-mono)]">
      <div className="max-w-[1600px] mx-auto">
        {/* Sticky controls */}
        <div ref={controlsRef} className="sticky top-0 z-20 bg-black pb-4 -mx-6 px-6 pt-0 border-b border-white/10">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                Signal Dashboard
              </h1>
              <p className="text-neutral-500 text-sm mt-1">
                {filtered.length} signal{filtered.length !== 1 ? "s" : ""} in
                last {filters.hours}h
                {pricesLoaded ? (
                  <span className="ml-2 text-emerald-500">
                    Live prices
                    <span className="text-neutral-600 ml-1 text-[10px]">({priceSource})</span>
                  </span>
                ) : (
                  <span className="ml-2 text-neutral-600">Prices unavailable</span>
                )}
              </p>
            </div>
            <button
              onClick={fetchSignals}
              className="text-sm px-3 py-1.5 border border-white/20 rounded hover:bg-white/10 transition-colors"
            >
              Refresh
            </button>
          </div>

          {/* Degraded schema banner */}
          {isDegraded && (
            <div className="mb-4 p-3 bg-yellow-900/30 border border-yellow-500/30 rounded text-yellow-300 text-xs leading-relaxed">
              <strong>Degraded mode</strong> — migration 014 not applied.
              Cluster metadata not persisted. Scores are fallback (not persisted).
              Rank/Selection/Grade columns are unavailable. Research comparison disabled.
            </div>
          )}

          {/* Selection stats — only shown when schema is full and data exists */}
          {!isDegraded &&
            selectionStats?.schema_available &&
            selectionStats.by_selection &&
            (selectionStats.comparison_eligible ?? 0) > 0 && (
              <div className="mb-4 flex gap-6 text-xs text-neutral-400 border border-white/5 rounded p-3">
                <span className="text-neutral-500">
                  Eligible: {selectionStats.comparison_eligible}
                  {(selectionStats.comparison_excluded_untagged ?? 0) > 0 && (
                    <span className="text-neutral-600 ml-1">
                      ({selectionStats.comparison_excluded_untagged} untagged excl)
                    </span>
                  )}
                </span>
                <span>
                  Selected: {selectionStats.by_selection.selected.total}
                  {selectionStats.by_selection.selected.win_rate != null && (
                    <span className="text-emerald-400 ml-1">
                      {selectionStats.by_selection.selected.win_rate}% WR
                    </span>
                  )}
                  {selectionStats.by_selection.selected.win_rate == null && (
                    <span className="text-neutral-600 ml-1">no data</span>
                  )}
                </span>
                <span>
                  Suppressed: {selectionStats.by_selection.suppressed.total}
                  {selectionStats.by_selection.suppressed.win_rate != null && (
                    <span className="text-neutral-500 ml-1">
                      {selectionStats.by_selection.suppressed.win_rate}% WR
                    </span>
                  )}
                  {selectionStats.by_selection.suppressed.win_rate == null && (
                    <span className="text-neutral-600 ml-1">no data</span>
                  )}
                </span>
              </div>
            )}

          {/* Filters */}
          <div className="flex gap-4 flex-wrap">
            <FilterGroup
              label="Window"
              options={HOUR_OPTIONS.map((h) => ({
                value: String(h),
                label: `${h}h`,
              }))}
              selected={String(filters.hours)}
              onSelect={(v) =>
                setFilters((f) => ({ ...f, hours: Number(v) }))
              }
            />
            <FilterGroup
              label="Tier"
              options={["all", "strict", "relaxed"].map((t) => ({
                value: t,
                label: t.charAt(0).toUpperCase() + t.slice(1),
              }))}
              selected={filters.tier}
              onSelect={(v) => setFilters((f) => ({ ...f, tier: v }))}
            />
            <FilterGroup
              label="Status"
              options={STATUS_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              selected={filters.statusFilter}
              onSelect={(v) =>
                setFilters((f) => ({ ...f, statusFilter: v }))
              }
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-900/40 border border-red-500/40 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        {strategyAudit?.schema_available && strategyAudit.totals && (
          <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.24em] text-neutral-500">
                  Strategy Audit
                </div>
                <h2 className="mt-1 text-sm font-semibold text-white">
                  Last {strategyAudit.days ?? 90}d by strategy and delivery mode
                </h2>
              </div>
              {strategyAudit.generated_at && (
                <div className="text-[11px] text-neutral-500">
                  Updated {formatTime(strategyAudit.generated_at)}
                </div>
              )}
            </div>

            <div className="mb-4 grid gap-3 md:grid-cols-4">
              <AuditStatCard
                label="Resolved"
                value={String(strategyAudit.totals.resolved_signals)}
                sublabel={`${strategyAudit.totals.total_signals} total`}
              />
              <AuditStatCard
                label="Win Rate"
                value={
                  strategyAudit.totals.win_rate != null
                    ? `${strategyAudit.totals.win_rate}%`
                    : "No data"
                }
                sublabel={`${strategyAudit.totals.wins}W / ${strategyAudit.totals.losses}L / ${strategyAudit.totals.neutral}N`}
              />
              <AuditStatCard
                label="Avg R"
                value={
                  strategyAudit.totals.avg_r != null
                    ? `${strategyAudit.totals.avg_r.toFixed(2)}R`
                    : "No data"
                }
                sublabel={`Total ${strategyAudit.totals.total_r.toFixed(2)}R`}
              />
              <AuditStatCard
                label="Profit Factor"
                value={
                  strategyAudit.totals.profit_factor == null
                    ? "No data"
                    : Number.isFinite(strategyAudit.totals.profit_factor)
                      ? strategyAudit.totals.profit_factor.toFixed(2)
                      : "Infinite"
                }
                sublabel={`${strategyAudit.totals.open_signals} still open`}
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <AuditBucketGrid
                title="Priority Slices"
                buckets={strategyAudit.priority_slices ?? []}
              />
              <AuditBucketGrid
                title="Delivery Modes"
                buckets={strategyAudit.delivery_modes ?? []}
              />
            </div>
          </div>
        )}

        {strategyAudit && !strategyAudit.schema_available && (
          <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-900/20 p-3 text-xs text-yellow-300">
            {strategyAudit.message ?? "Strategy audit unavailable until the extended schema is applied."}
          </div>
        )}

        {/* Table — overflow-x:clip avoids creating a scroll container so sticky works vertically */}
        <div className="border border-white/10 rounded-lg" style={{ overflowX: "clip" }}>
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              {(() => {
                const thCls = "px-2 py-2.5 sticky bg-black border-b border-white/10";
                const thStyle = { top: controlsHeight, zIndex: 10 };
                return (
                  <tr className="text-neutral-400 text-left">
                    <th className={thCls} style={thStyle}>Symbol</th>
                    <th className={thCls} style={thStyle}>Side</th>
                    <th className={thCls} style={thStyle}>Type</th>
                    <th className={thCls} style={thStyle}>Tier</th>
                    <th className={`${thCls} text-right`} style={thStyle}>
                      Score{isDegraded && <span className="text-neutral-600 text-[10px] ml-0.5">*</span>}
                    </th>
                    {!isDegraded && <th className={`${thCls} text-center`} style={thStyle}>Rank</th>}
                    {!isDegraded && <th className={`${thCls} text-center`} style={thStyle}>Ops</th>}
                    <th className={thCls} style={thStyle}>Time</th>
                    <th className={`${thCls} text-right`} style={thStyle}>Entry</th>
                    <th className={`${thCls} text-right`} style={thStyle}>Current</th>
                    <th className={`${thCls} text-right`} style={thStyle}>Stop</th>
                    <th className={`${thCls} text-right`} style={thStyle}>TP1</th>
                    <th className={`${thCls} text-center`} style={thStyle}>Live</th>
                    <th className={`${thCls} text-right`} style={thStyle}>10x</th>
                    {!isDegraded && <th className={`${thCls} text-center`} style={thStyle}>Grade</th>}
                    <th className={`${thCls} text-center`} style={thStyle}>TV</th>
                  </tr>
                );
              })()}
            </thead>
            <tbody>
              {loading && signals.length === 0 ? (
                <tr>
                  <td
                    colSpan={COL_SPAN + 1}
                    className="px-3 py-8 text-center text-neutral-500"
                  >
                    Loading...
                  </td>
                </tr>
              ) : clusters.length === 0 ? (
                <tr>
                  <td
                    colSpan={COL_SPAN + 1}
                    className="px-3 py-8 text-center text-neutral-500"
                  >
                    No signals match filters
                  </td>
                </tr>
              ) : (
                clusters.map((cluster) => (
                  <ClusterGroup
                    key={cluster.key}
                    cluster={cluster}
                    isDegraded={isDegraded}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="mt-4 text-xs text-neutral-600">
          Auto-refreshes every 30s
          {isDegraded && " · Score is fallback (not persisted)"}
        </div>
      </div>
    </div>
  );
}

// ── Filter group ───────────────────────────────────────

function FilterGroup({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-neutral-500 text-sm">{label}:</span>
      <div className="flex gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onSelect(o.value)}
            className={`text-sm px-2.5 py-1 rounded transition-colors ${
              selected === o.value
                ? "bg-white text-black"
                : "border border-white/20 hover:bg-white/10"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AuditStatCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold text-white">{value}</div>
      <div className="mt-1 text-[11px] text-neutral-500">{sublabel}</div>
    </div>
  );
}

function AuditBucketGrid({
  title,
  buckets,
}: {
  title: string;
  buckets: StrategyAuditBucket[];
}) {
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-[0.22em] text-neutral-500">
        {title}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {buckets.map((bucket) => (
          <div key={bucket.key} className="rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-white">{bucket.label}</div>
                <div className="mt-1 text-[11px] text-neutral-500">
                  {bucket.total_signals} total · {bucket.resolved_signals} resolved · {bucket.open_signals} open
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-emerald-400">
                  {bucket.win_rate != null ? `${bucket.win_rate}%` : "No data"}
                </div>
                <div className="text-[11px] text-neutral-500">WR</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-neutral-400">
              <span>{bucket.wins}W</span>
              <span>{bucket.losses}L</span>
              <span>{bucket.neutral}N</span>
              <span>{bucket.avg_r != null ? `${bucket.avg_r.toFixed(2)}R avg` : "No avg R"}</span>
              <span>{bucket.total_r.toFixed(2)}R total</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Cluster group ──────────────────────────────────────

function ClusterGroup({
  cluster,
  isDegraded,
}: {
  cluster: Cluster;
  isDegraded: boolean;
}) {
  const colCount = isDegraded ? COL_SPAN - 2 : COL_SPAN + 1;
  return (
    <>
      <tr className="bg-white/[0.03]">
        <td colSpan={colCount} className="px-2 py-2">
          <div className="flex items-center gap-3 text-xs">
            <span className="font-medium text-neutral-300">
              {cluster.label}
            </span>
            <span className="text-neutral-500">{cluster.total} signals</span>
            {!isDegraded && cluster.selected > 0 && (
              <span className="text-blue-400">
                {cluster.selected} selected
              </span>
            )}
            {!isDegraded && cluster.suppressed > 0 && (
              <span className="text-neutral-500">
                {cluster.suppressed} suppressed
              </span>
            )}
            {!isDegraded && cluster.pending > 0 && (
              <span className="text-yellow-500">
                {cluster.pending} pending
              </span>
            )}
            <span className="text-neutral-600">|</span>
            {cluster.open > 0 && (
              <span className="text-neutral-400">{cluster.open} open</span>
            )}
            {cluster.tp1 > 0 && (
              <span className="text-emerald-500">{cluster.tp1} TP1</span>
            )}
            {cluster.tp2 > 0 && (
              <span className="text-emerald-400">{cluster.tp2} TP2</span>
            )}
            {cluster.tp3 > 0 && (
              <span className="text-emerald-300">{cluster.tp3} TP3</span>
            )}
            {cluster.stopped > 0 && (
              <span className="text-red-400">{cluster.stopped} stopped</span>
            )}
          </div>
        </td>
      </tr>
      {cluster.signals.map((s) => (
        <SignalRow key={s.id} signal={s} isDegraded={isDegraded} />
      ))}
    </>
  );
}

// ── Signal row ─────────────────────────────────────────

function SignalRow({
  signal: s,
  isDegraded,
}: {
  signal: Signal;
  isDegraded: boolean;
}) {
  const suppressTitle = s.suppressed_reason
    ? `Suppressed: ${s.suppressed_reason}`
    : undefined;
  const ops = operatorBadge(s);

  return (
    <tr
      className={`border-b border-white/5 hover:bg-white/5 transition-colors ${
        !isDegraded && !s.selected_for_execution && s.suppressed_reason
          ? "opacity-50"
          : ""
      }`}
    >
      <td className="px-2 py-2 font-medium">
        <div>{s.symbol.replace(/USDT$/i, "")}</div>
        <div className="mt-0.5 text-[11px] font-normal text-neutral-500">
          {fmtEnumLabel(s.btc_regime ?? "unknown")} · {operatorReason(s)}
        </div>
      </td>
      <td className="px-2 py-2">
        <span
          className={
            s.decision.includes("LONG") ? "text-emerald-400" : "text-red-400"
          }
        >
          {s.decision}
        </span>
      </td>
      <td className="px-2 py-2 text-neutral-300">{s.setup_family}</td>
      <td className="px-2 py-2">
        <span
          className={`text-xs px-1.5 py-0.5 rounded ${
            s.tier === "STRICT"
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-yellow-500/20 text-yellow-400"
          }`}
        >
          {s.tier}
        </span>
      </td>
      <td
        className={`px-2 py-2 text-right tabular-nums ${scoreColor(s.score)}`}
      >
        {s.score > 0 ? s.score.toFixed(1) : "-"}
      </td>
      {!isDegraded && (
        <td className="px-2 py-2 text-center tabular-nums text-neutral-400">
          {s.cluster_rank != null ? `#${s.cluster_rank}` : "-"}
        </td>
      )}
      {!isDegraded && (
        <td className="px-2 py-2 text-center" title={suppressTitle ?? ops.title}>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${ops.className}`}
          >
            {ops.label}
          </span>
        </td>
      )}
      <td className="px-2 py-2 text-neutral-400">
        {formatTime(s.created_at)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {formatPrice(s.entry_price)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums font-medium">
        {formatPrice(s.current_price)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-red-400/80">
        {formatPrice(s.stop_price)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-emerald-400/80">
        {formatPrice(s.tp1_price)}
      </td>
      <td className="px-2 py-2 text-center">
        <LiveStatusCell signal={s} />
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-emerald-400/80">
        {positionRef(s)}
      </td>
      {!isDegraded && (
        <td
          className={`px-2 py-2 text-center text-xs ${gradedColor(s.graded_outcome)}`}
        >
          {s.graded_outcome ?? "-"}
        </td>
      )}
      <td className="px-2 py-2 text-center">
        <a
          href={tradingViewUrl(s.symbol)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
        >
          TV
        </a>
      </td>
    </tr>
  );
}

// ── Live status cell ──────────────────────────────────

function LiveStatusCell({ signal: s }: { signal: Signal }) {
  if (s.current_price == null) {
    return <span className="text-neutral-600 text-xs">No price</span>;
  }

  if (s.live_stop_hit) {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded text-red-400 bg-red-500/20">
        STOPPED
      </span>
    );
  }

  // Show TP progress badges: each TP lights up when hit
  return (
    <div className="flex items-center justify-center gap-0.5">
      <span
        className={`text-[10px] px-1 py-0.5 rounded ${
          s.live_tp1_hit
            ? "text-emerald-400 bg-emerald-500/20"
            : "text-neutral-600 bg-transparent"
        }`}
        title={s.live_tp1_hit ? "TP1 hit" : `TP1: ${formatPrice(s.tp1_price)}`}
      >
        T1
      </span>
      <span
        className={`text-[10px] px-1 py-0.5 rounded ${
          s.live_tp2_hit
            ? "text-emerald-300 bg-emerald-500/15"
            : "text-neutral-600 bg-transparent"
        }`}
        title={s.live_tp2_hit ? "TP2 hit" : `TP2: ${formatPrice(s.tp2_price)}`}
      >
        T2
      </span>
      <span
        className={`text-[10px] px-1 py-0.5 rounded ${
          s.live_tp3_hit
            ? "text-emerald-200 bg-emerald-500/25"
            : "text-neutral-600 bg-transparent"
        }`}
        title={s.live_tp3_hit ? "TP3 hit" : `TP3: ${formatPrice(s.tp3_price)}`}
      >
        T3
      </span>
      {!s.live_tp1_hit && s.pct_to_tp1 != null && Number.isFinite(s.pct_to_tp1) && (
        <span
          className={`text-[10px] ml-0.5 tabular-nums ${
            s.pct_to_tp1 >= 0 ? "text-neutral-400" : "text-red-400"
          }`}
        >
          {s.pct_to_tp1.toFixed(0)}%
        </span>
      )}
    </div>
  );
}
