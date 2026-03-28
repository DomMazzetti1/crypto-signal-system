"use client";

import { useCallback, useEffect, useState } from "react";

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
  telegram_sent: boolean;
  telegram_attempted: boolean;
  blocked_reason: string | null;
  gate_a_quality: string | null;
  gate_b_passed: boolean;
};

type Filters = {
  hours: number;
  tier: string; // "all" | "strict" | "relaxed"
};

function tradingViewUrl(symbol: string): string {
  // Strip USDT suffix for TradingView — use BYBIT exchange
  const clean = symbol.replace(/USDT$/i, "");
  return `https://www.tradingview.com/chart/?symbol=BYBIT%3A${clean}USDT.P`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
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

const HOUR_OPTIONS = [4, 12, 24] as const;

export default function SignalsDashboard() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    hours: 24,
    tier: "all",
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 30_000); // auto-refresh 30s
    return () => clearInterval(interval);
  }, [fetchSignals]);

  return (
    <div className="min-h-screen bg-black text-white p-6 font-[family-name:var(--font-geist-mono)]">
      {/* Header */}
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Signal Dashboard
            </h1>
            <p className="text-neutral-500 text-sm mt-1">
              {signals.length} signal{signals.length !== 1 ? "s" : ""} in last{" "}
              {filters.hours}h
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
          {/* Time window */}
          <div className="flex items-center gap-2">
            <span className="text-neutral-500 text-sm">Window:</span>
            <div className="flex gap-1">
              {HOUR_OPTIONS.map((h) => (
                <button
                  key={h}
                  onClick={() => setFilters((f) => ({ ...f, hours: h }))}
                  className={`text-sm px-2.5 py-1 rounded transition-colors ${
                    filters.hours === h
                      ? "bg-white text-black"
                      : "border border-white/20 hover:bg-white/10"
                  }`}
                >
                  {h}h
                </button>
              ))}
            </div>
          </div>

          {/* Tier filter */}
          <div className="flex items-center gap-2">
            <span className="text-neutral-500 text-sm">Tier:</span>
            <div className="flex gap-1">
              {(["all", "strict", "relaxed"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setFilters((f) => ({ ...f, tier: t }))}
                  className={`text-sm px-2.5 py-1 rounded capitalize transition-colors ${
                    filters.tier === t
                      ? "bg-white text-black"
                      : "border border-white/20 hover:bg-white/10"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-900/40 border border-red-500/40 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto border border-white/10 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-neutral-400 text-left">
                <th className="px-3 py-2.5">Symbol</th>
                <th className="px-3 py-2.5">Side</th>
                <th className="px-3 py-2.5">Alert Type</th>
                <th className="px-3 py-2.5">Tier</th>
                <th className="px-3 py-2.5">Time</th>
                <th className="px-3 py-2.5 text-right">Entry</th>
                <th className="px-3 py-2.5 text-right">Stop</th>
                <th className="px-3 py-2.5 text-right">TP1</th>
                <th className="px-3 py-2.5 text-right">TP2</th>
                <th className="px-3 py-2.5 text-center">Telegram</th>
                <th className="px-3 py-2.5 text-center">Chart</th>
              </tr>
            </thead>
            <tbody>
              {loading && signals.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-neutral-500">
                    Loading...
                  </td>
                </tr>
              ) : signals.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-neutral-500">
                    No signals in this window
                  </td>
                </tr>
              ) : (
                signals.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-white/5 hover:bg-white/5 transition-colors"
                  >
                    <td className="px-3 py-2 font-medium">
                      {s.symbol.replace(/USDT$/i, "")}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          s.decision === "LONG"
                            ? "text-emerald-400"
                            : "text-red-400"
                        }
                      >
                        {s.decision}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-300">
                      {s.setup_family}
                    </td>
                    <td className="px-3 py-2">
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
                    <td className="px-3 py-2 text-neutral-400">
                      {formatTime(s.created_at)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatPrice(s.entry_price)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-400/80">
                      {formatPrice(s.stop_price)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400/80">
                      {formatPrice(s.tp1_price)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400/80">
                      {formatPrice(s.tp2_price)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {s.telegram_sent ? (
                        <span className="text-emerald-400">Sent</span>
                      ) : s.blocked_reason ? (
                        <span className="text-yellow-400" title={s.blocked_reason}>
                          Blocked
                        </span>
                      ) : s.telegram_attempted ? (
                        <span className="text-red-400">Failed</span>
                      ) : (
                        <span className="text-neutral-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
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
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="mt-4 text-xs text-neutral-600">
          Auto-refreshes every 30s
        </div>
      </div>
    </div>
  );
}
