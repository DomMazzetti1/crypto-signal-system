"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
  pct_to_tp1: number | null;
  score: number;
  // Cluster metadata
  cluster_id: string | null;
  cluster_size: number;
  cluster_rank: number | null;
  // Execution selection
  selected_for_execution: boolean;
  suppressed_reason: string | null;
  // Graded outcome (research, distinct from live status)
  graded_outcome: string | null;
  // Lifecycle
  tp1_hit_at: string | null;
  tp2_hit_at: string | null;
  tp3_hit_at: string | null;
  stopped_at: string | null;
  resolved_at: string | null;
  // Existing
  telegram_sent: boolean;
  telegram_attempted: boolean;
  blocked_reason: string | null;
  gate_a_quality: string | null;
  gate_b_passed: boolean;
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
  if (val >= 1000) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);
  return val.toPrecision(4);
}

function statusColor(status: string): string {
  switch (status) {
    case "TP3_HIT":
      return "text-emerald-300 bg-emerald-500/20";
    case "TP2_HIT":
      return "text-emerald-400 bg-emerald-500/15";
    case "TP1_HIT":
      return "text-emerald-500 bg-emerald-500/10";
    case "STOPPED":
      return "text-red-400 bg-red-500/20";
    case "OPEN":
      return "text-neutral-300 bg-white/5";
    default:
      return "text-neutral-500 bg-white/5";
  }
}

function gradedColor(outcome: string | null): string {
  if (!outcome) return "text-neutral-600";
  if (outcome.startsWith("WIN")) return "text-emerald-400";
  if (outcome === "LOSS") return "text-red-400";
  return "text-yellow-400";
}

function clusterKey(signal: Signal): string {
  // Use persisted cluster_id if available, else derive from created_at hour
  if (signal.cluster_id) return signal.cluster_id;
  const d = new Date(signal.created_at);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

function clusterLabel(key: string): string {
  // Persisted cluster_id format: "YYYY-MM-DDTHH:DIRECTION:REGIME"
  // Derived format: ISO string
  const hourPart = key.slice(0, 13); // "YYYY-MM-DDTHH"
  const rest = key.slice(14); // "LONG:bear" or empty
  const d = new Date(hourPart + ":00:00.000Z");
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
  const leverage = 10;
  const returnPct = pctMove * leverage * 100;
  return `+${returnPct.toFixed(1)}%`;
}

function matchesStatus(signal: Signal, filter: string): boolean {
  switch (filter) {
    case "open":
      return signal.status === "OPEN";
    case "tp_hits":
      return signal.status.startsWith("TP");
    case "stopped":
      return signal.status === "STOPPED";
    default:
      return true;
  }
}

function scoreColor(score: number): string {
  if (score >= 70) return "text-emerald-400";
  if (score >= 50) return "text-yellow-400";
  if (score >= 30) return "text-orange-400";
  return "text-red-400";
}

// ── Constants ──────────────────────────────────────────

const HOUR_OPTIONS = [4, 12, 24] as const;
const STATUS_OPTIONS = [
  { value: "open", label: "Open Only" },
  { value: "all", label: "All" },
  { value: "tp_hits", label: "TP Hits" },
  { value: "stopped", label: "Stopped" },
] as const;

const COL_SPAN = 16;

// ── Component ──────────────────────────────────────────

export default function SignalsDashboard() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pricesLoaded, setPricesLoaded] = useState(false);
  const [filters, setFilters] = useState<Filters>({
    hours: 4,
    tier: "all",
    statusFilter: "open",
  });

  const fetchSignals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ hours: String(filters.hours) });
      if (filters.tier !== "all") params.set("tier", filters.tier);
      const res = await fetch(`/api/dashboard/active-signals?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSignals(json.signals);
      setPricesLoaded(json.prices_loaded);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 30_000);
    return () => clearInterval(interval);
  }, [fetchSignals]);

  // Apply client-side status filter, sort by score desc then cluster_rank asc
  const filtered = useMemo(() => {
    return signals
      .filter((s) => matchesStatus(s, filters.statusFilter))
      .sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        return (a.cluster_rank ?? 999) - (b.cluster_rank ?? 999);
      });
  }, [signals, filters.statusFilter]);

  // Group into clusters using persisted cluster_id
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
        open: sigs.filter((s) => s.status === "OPEN").length,
        tp1: sigs.filter((s) => s.status === "TP1_HIT").length,
        tp2: sigs.filter((s) => s.status === "TP2_HIT").length,
        tp3: sigs.filter((s) => s.status === "TP3_HIT").length,
        stopped: sigs.filter((s) => s.status === "STOPPED").length,
        selected: sigs.filter((s) => s.selected_for_execution).length,
        suppressed: sigs.filter((s) => s.suppressed_reason != null).length,
      });
    }
    result.sort((a, b) => b.key.localeCompare(a.key));
    return result;
  }, [filtered]);

  return (
    <div className="min-h-screen bg-black text-white p-6 font-[family-name:var(--font-geist-mono)]">
      <div className="max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Signal Dashboard
            </h1>
            <p className="text-neutral-500 text-sm mt-1">
              {filtered.length} signal{filtered.length !== 1 ? "s" : ""} in
              last {filters.hours}h
              {pricesLoaded && (
                <span className="ml-2 text-emerald-500">Live</span>
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

        {/* Filters */}
        <div className="flex gap-4 mb-6 flex-wrap">
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

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-900/40 border border-red-500/40 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto border border-white/10 rounded-lg">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b border-white/10 text-neutral-400 text-left">
                <th className="px-2 py-2.5">Symbol</th>
                <th className="px-2 py-2.5">Side</th>
                <th className="px-2 py-2.5">Type</th>
                <th className="px-2 py-2.5">Tier</th>
                <th className="px-2 py-2.5 text-right">Score</th>
                <th className="px-2 py-2.5 text-center">Rank</th>
                <th className="px-2 py-2.5 text-center">Sel</th>
                <th className="px-2 py-2.5">Time</th>
                <th className="px-2 py-2.5 text-right">Entry</th>
                <th className="px-2 py-2.5 text-right">Current</th>
                <th className="px-2 py-2.5 text-right">Stop</th>
                <th className="px-2 py-2.5 text-right">TP1</th>
                <th className="px-2 py-2.5 text-center">Status</th>
                <th className="px-2 py-2.5 text-right">%TP1</th>
                <th className="px-2 py-2.5 text-right">10x</th>
                <th className="px-2 py-2.5 text-center">Grade</th>
                <th className="px-2 py-2.5 text-center">TV</th>
              </tr>
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
                  <ClusterGroup key={cluster.key} cluster={cluster} />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="mt-4 text-xs text-neutral-600">
          Auto-refreshes every 30s &middot; Score desc, then cluster rank asc
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

// ── Cluster group ──────────────────────────────────────

function ClusterGroup({ cluster }: { cluster: Cluster }) {
  return (
    <>
      <tr className="bg-white/[0.03]">
        <td colSpan={COL_SPAN + 1} className="px-2 py-2">
          <div className="flex items-center gap-3 text-xs">
            <span className="font-medium text-neutral-300">
              {cluster.label}
            </span>
            <span className="text-neutral-500">{cluster.total} signals</span>
            {cluster.selected > 0 && (
              <span className="text-blue-400">{cluster.selected} selected</span>
            )}
            {cluster.suppressed > 0 && (
              <span className="text-neutral-500">
                {cluster.suppressed} suppressed
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
        <SignalRow key={s.id} signal={s} />
      ))}
    </>
  );
}

// ── Signal row ─────────────────────────────────────────

function SignalRow({ signal: s }: { signal: Signal }) {
  const suppressTitle = s.suppressed_reason
    ? `Suppressed: ${s.suppressed_reason}`
    : undefined;

  return (
    <tr
      className={`border-b border-white/5 hover:bg-white/5 transition-colors ${
        !s.selected_for_execution && s.suppressed_reason
          ? "opacity-50"
          : ""
      }`}
    >
      <td className="px-2 py-2 font-medium">
        {s.symbol.replace(/USDT$/i, "")}
      </td>
      <td className="px-2 py-2">
        <span
          className={
            s.decision === "LONG" ? "text-emerald-400" : "text-red-400"
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
      <td className={`px-2 py-2 text-right tabular-nums ${scoreColor(s.score)}`}>
        {s.score > 0 ? s.score.toFixed(1) : "-"}
      </td>
      <td className="px-2 py-2 text-center tabular-nums text-neutral-400">
        {s.cluster_rank != null ? `#${s.cluster_rank}` : "-"}
      </td>
      <td className="px-2 py-2 text-center" title={suppressTitle}>
        {s.selected_for_execution ? (
          <span className="text-blue-400">Y</span>
        ) : s.suppressed_reason ? (
          <span className="text-neutral-500 cursor-help">N</span>
        ) : (
          <span className="text-neutral-600">-</span>
        )}
      </td>
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
        <span
          className={`text-xs px-1.5 py-0.5 rounded ${statusColor(s.status)}`}
        >
          {s.status.replace("_", " ")}
        </span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {s.pct_to_tp1 != null ? (
          <span
            className={
              s.pct_to_tp1 >= 100
                ? "text-emerald-400"
                : s.pct_to_tp1 >= 0
                  ? "text-neutral-300"
                  : "text-red-400"
            }
          >
            {s.pct_to_tp1.toFixed(0)}%
          </span>
        ) : (
          "-"
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-emerald-400/80">
        {positionRef(s)}
      </td>
      <td className={`px-2 py-2 text-center text-xs ${gradedColor(s.graded_outcome)}`}>
        {s.graded_outcome ?? "-"}
      </td>
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
