"use client";

import { useEffect, useState, useCallback } from "react";

const REFRESH_INTERVAL = 30_000;

// ── Types ──────────────────────────────────────────────

interface ExecHealth {
  status: string;
  mode?: string;
  uptime?: number;
  open_positions?: number;
  account_equity?: number;
  signals_this_hour?: number;
  started_at?: string;
  last_bybit_success?: string | null;
  bybit_stale?: boolean;
  error?: string;
}

interface Signal {
  id: string;
  symbol: string;
  decision: string;
  alert_type: string;
  tier: string;
  created_at: string;
  entry_price: number | null;
  stop_price: number | null;
  tp1_price: number | null;
  tp2_price: number | null;
  tp3_price: number | null;
  current_price: number | null;
  rr_tp1: number | null;
  pct_to_tp1: number | null;
  score: number | null;
  live_status: string;
  graded_outcome: string | null;
  telegram_sent: boolean;
  gate_b_passed: boolean;
  gate_b_reason: string | null;
  blocked_reason: string | null;
}

interface ScannerRun {
  completed_at: string;
  symbols_scanned: number;
  candidates_found: number;
  candidates_queued?: number;
  runtime_ms: number;
}

interface ProdHealth {
  recent_decisions: {
    symbol: string;
    alert_type: string;
    decision: string;
    gate_b: boolean;
    gate_b_reason: string | null;
    telegram_sent: boolean;
    created_at: string;
  }[];
  scanner_recent: ScannerRun[];
}

interface DashboardData {
  exec: ExecHealth | null;
  signals: Signal[];
  prodHealth: ProdHealth | null;
  priceSource: string;
}

// ── Helpers ────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h ago`;
}

function fmtPrice(n: number | null): string {
  if (n == null) return "--";
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function deriveTier(alertType: string): string {
  if (/_RELAXED$/i.test(alertType)) return "RELAXED";
  if (/_DATA$/i.test(alertType)) return "DATA";
  return "STRICT";
}

function computeCurrentR(
  decision: string,
  entry: number | null,
  stop: number | null,
  current: number | null
): number | null {
  if (entry == null || stop == null || current == null) return null;
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  const isLong = decision === "LONG" || decision === "MR_LONG";
  const pnl = isLong ? current - entry : entry - current;
  return pnl / risk;
}

function hoursUntilExpiry(createdAt: string, maxHours = 48): number {
  const elapsed = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  return Math.max(0, maxHours - elapsed);
}

// ── Data fetching ──────────────────────────────────────

async function fetchDashboard(): Promise<DashboardData> {
  const [execRes, signalsRes, healthRes] = await Promise.allSettled([
    fetch("/api/proxy/exec-health").then(r => r.json()),
    fetch("/api/dashboard/active-signals?hours=720").then(r => r.json()),
    fetch("/api/debug/production-health").then(r => r.json()),
  ]);

  return {
    exec: execRes.status === "fulfilled" ? execRes.value : null,
    signals: signalsRes.status === "fulfilled" ? (signalsRes.value.signals ?? []) : [],
    prodHealth: healthRes.status === "fulfilled" ? healthRes.value : null,
    priceSource: signalsRes.status === "fulfilled" ? (signalsRes.value.price_source ?? "none") : "none",
  };
}

// ── Components ─────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-500 mb-3 border-b border-white/10 pb-1">
      {children}
    </h2>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between text-sm border-b border-white/5 py-1.5">
      <span className="text-neutral-500">{label}</span>
      <span className={warn ? "text-red-400 font-medium" : ""}>{value}</span>
    </div>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  const colors: Record<string, string> = {
    green: "bg-emerald-900/50 text-emerald-400 border-emerald-800",
    red: "bg-red-900/50 text-red-400 border-red-800",
    yellow: "bg-yellow-900/50 text-yellow-400 border-yellow-800",
    blue: "bg-blue-900/50 text-blue-400 border-blue-800",
    neutral: "bg-neutral-800/50 text-neutral-400 border-neutral-700",
  };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${colors[color] ?? colors.neutral}`}>
      {text}
    </span>
  );
}

// ── Exec Engine Status ─────────────────────────────────

function ExecEngineSection({ exec }: { exec: ExecHealth | null }) {
  const isDown = !exec || exec.status === "down" || exec.status === "error";
  const isStale = exec?.bybit_stale === true;
  const showAlert = isDown || isStale;

  return (
    <section>
      <SectionHeader>Execution Engine</SectionHeader>

      {showAlert && (
        <div className="bg-red-950/60 border border-red-800 rounded px-3 py-2 mb-3 text-sm text-red-300">
          {isDown
            ? `Engine unreachable: ${exec?.error ?? "no response"}`
            : "Bybit connection stale — last success >2m ago"}
        </div>
      )}

      {exec && !isDown ? (
        <div className="space-y-0">
          <Stat label="Status" value={exec.status === "running" ? "RUNNING" : exec.status?.toUpperCase() ?? "UNKNOWN"} warn={exec.status !== "running"} />
          <Stat label="Mode" value={exec.mode ?? "--"} warn={exec.mode === "TESTNET"} />
          <Stat label="Account equity" value={exec.account_equity != null ? `$${exec.account_equity.toFixed(2)}` : "--"} />
          <Stat label="Open positions" value={String(exec.open_positions ?? 0)} />
          <Stat label="Signals this hour" value={String(exec.signals_this_hour ?? 0)} />
          <Stat label="Uptime" value={exec.uptime != null ? fmtUptime(exec.uptime) : "--"} />
          <Stat label="Last Bybit success" value={exec.last_bybit_success ? timeAgo(exec.last_bybit_success) : "never"} warn={isStale} />
        </div>
      ) : (
        <p className="text-sm text-neutral-600">Unable to connect to execution engine</p>
      )}
    </section>
  );
}

// ── Open Positions ─────────────────────────────────────

function OpenPositionsSection({ signals }: { signals: Signal[] }) {
  const open = signals.filter(s => s.telegram_sent && !s.graded_outcome);

  return (
    <section>
      <SectionHeader>Open Positions ({open.length})</SectionHeader>

      {open.length === 0 ? (
        <p className="text-sm text-neutral-600">No open positions</p>
      ) : (
        <div className="space-y-2">
          {open.map(s => {
            const currentR = computeCurrentR(s.decision, s.entry_price, s.stop_price, s.current_price);
            const pctTp1 = s.pct_to_tp1;
            const hoursLeft = hoursUntilExpiry(s.created_at);
            const isLong = s.decision === "LONG" || s.decision === "MR_LONG";
            const movingRight = currentR != null && currentR > 0;

            return (
              <div key={s.id} className={`rounded border px-3 py-2 text-xs ${movingRight ? "border-emerald-900/60 bg-emerald-950/20" : "border-red-900/60 bg-red-950/20"}`}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm">{s.symbol}</span>
                    <Badge text={s.decision} color={isLong ? "green" : "red"} />
                    <Badge text={deriveTier(s.alert_type)} color={deriveTier(s.alert_type) === "STRICT" ? "blue" : "yellow"} />
                  </div>
                  <span className="text-neutral-500">{timeAgo(s.created_at)}</span>
                </div>

                <div className="grid grid-cols-4 gap-x-4 gap-y-1 text-neutral-400">
                  <div>Entry <span className="text-white">{fmtPrice(s.entry_price)}</span></div>
                  <div>Current <span className={movingRight ? "text-emerald-400" : "text-red-400"}>{fmtPrice(s.current_price)}</span></div>
                  <div>Stop <span className="text-red-400/70">{fmtPrice(s.stop_price)}</span></div>
                  <div>R <span className={currentR != null && currentR >= 0 ? "text-emerald-400 font-medium" : "text-red-400 font-medium"}>{currentR != null ? `${currentR >= 0 ? "+" : ""}${currentR.toFixed(2)}` : "--"}</span></div>
                </div>

                <div className="grid grid-cols-4 gap-x-4 mt-1 text-neutral-400">
                  <div>TP1 <span className="text-neutral-300">{fmtPrice(s.tp1_price)}</span></div>
                  <div>TP2 <span className="text-neutral-300">{fmtPrice(s.tp2_price)}</span></div>
                  <div>TP3 <span className="text-neutral-300">{fmtPrice(s.tp3_price)}</span></div>
                  <div>Exp <span className="text-neutral-300">{hoursLeft.toFixed(0)}h</span></div>
                </div>

                {/* Progress bar to TP1 */}
                <div className="mt-2 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${pctTp1 != null && pctTp1 >= 0 ? "bg-emerald-500" : "bg-red-500"}`}
                    style={{ width: `${Math.max(0, Math.min(100, pctTp1 ?? 0))}%` }}
                  />
                </div>
                <div className="text-[10px] text-neutral-600 mt-0.5">
                  {pctTp1 != null ? `${pctTp1.toFixed(0)}% to TP1` : "no price data"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Performance Summary ────────────────────────────────

interface DayPerf {
  day: string;
  wins: number;
  losses: number;
  total: number;
}

function PerformanceSection({ signals }: { signals: Signal[] }) {
  const graded = signals.filter(s => s.telegram_sent && s.graded_outcome);

  const wins = graded.filter(s => s.graded_outcome?.startsWith("WIN"));
  const losses = graded.filter(s => s.graded_outcome === "LOSS");
  const winRate = graded.length > 0 ? (wins.length / graded.length * 100).toFixed(1) : "--";

  // Avg R: approximate from graded outcomes
  // WIN_TP1 ~ 1.5R, WIN_TP2 ~ 3R, WIN_TP3 ~ 4.5R, LOSS ~ -1R, WIN_BE ~ 0R
  function estimateR(outcome: string | null): number {
    if (!outcome) return 0;
    if (outcome === "WIN_TP3") return 4.5;
    if (outcome === "WIN_TP2") return 3;
    if (outcome === "WIN_TP1") return 1.5;
    if (outcome === "WIN_BE" || outcome === "WIN_BREAKEVEN") return 0;
    if (outcome === "LOSS") return -1;
    if (outcome.startsWith("WIN")) return 1.5;
    return 0;
  }

  const totalR = graded.reduce((sum, s) => sum + estimateR(s.graded_outcome), 0);
  const avgR = graded.length > 0 ? (totalR / graded.length).toFixed(2) : "--";
  const totalWinR = wins.reduce((sum, s) => sum + Math.max(0, estimateR(s.graded_outcome)), 0);
  const totalLossR = losses.reduce((sum, s) => sum + Math.abs(estimateR(s.graded_outcome)), 0);
  const pf = totalLossR > 0 ? (totalWinR / totalLossR).toFixed(2) : wins.length > 0 ? "inf" : "--";

  // Win rate by day (last 7 days)
  const dayMap = new Map<string, DayPerf>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", { weekday: "short" });
    dayMap.set(key, { day: label, wins: 0, losses: 0, total: 0 });
  }
  for (const s of graded) {
    const key = s.created_at.slice(0, 10);
    const entry = dayMap.get(key);
    if (!entry) continue;
    entry.total++;
    if (s.graded_outcome?.startsWith("WIN")) entry.wins++;
    else entry.losses++;
  }
  const days = Array.from(dayMap.values());
  const maxDay = Math.max(...days.map(d => d.total), 1);

  return (
    <section>
      <SectionHeader>Performance (TG Signals)</SectionHeader>

      <div className="grid grid-cols-5 gap-2 mb-4">
        <div className="bg-neutral-900 rounded px-2 py-1.5 text-center">
          <div className="text-lg font-bold">{graded.length}</div>
          <div className="text-[10px] text-neutral-500 uppercase">Graded</div>
        </div>
        <div className="bg-neutral-900 rounded px-2 py-1.5 text-center">
          <div className="text-lg font-bold text-emerald-400">{winRate}%</div>
          <div className="text-[10px] text-neutral-500 uppercase">Win Rate</div>
        </div>
        <div className="bg-neutral-900 rounded px-2 py-1.5 text-center">
          <div className="text-lg font-bold">{avgR}</div>
          <div className="text-[10px] text-neutral-500 uppercase">Avg R</div>
        </div>
        <div className="bg-neutral-900 rounded px-2 py-1.5 text-center">
          <div className="text-lg font-bold">{pf}</div>
          <div className="text-[10px] text-neutral-500 uppercase">PF</div>
        </div>
        <div className="bg-neutral-900 rounded px-2 py-1.5 text-center">
          <div className={`text-lg font-bold ${totalR >= 0 ? "text-emerald-400" : "text-red-400"}`}>{totalR >= 0 ? "+" : ""}{totalR.toFixed(1)}</div>
          <div className="text-[10px] text-neutral-500 uppercase">Total R</div>
        </div>
      </div>

      {/* 7-day bar chart */}
      <div className="flex items-end gap-1 h-16">
        {days.map((d, i) => (
          <div key={i} className="flex-1 flex flex-col items-center">
            <div className="w-full flex flex-col-reverse" style={{ height: 48 }}>
              {d.total > 0 && (
                <div className="w-full flex flex-col-reverse" style={{ height: `${(d.total / maxDay) * 100}%` }}>
                  <div className="bg-red-800 rounded-t-sm" style={{ height: `${d.total > 0 ? (d.losses / d.total) * 100 : 0}%`, minHeight: d.losses > 0 ? 2 : 0 }} />
                  <div className="bg-emerald-600 rounded-t-sm" style={{ height: `${d.total > 0 ? (d.wins / d.total) * 100 : 0}%`, minHeight: d.wins > 0 ? 2 : 0 }} />
                </div>
              )}
            </div>
            <span className="text-[9px] text-neutral-600 mt-1">{d.day}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Recent Signals ─────────────────────────────────────

function RecentSignalsSection({ health }: { health: ProdHealth | null }) {
  const decisions = health?.recent_decisions?.slice(0, 10) ?? [];

  return (
    <section>
      <SectionHeader>Recent Signals</SectionHeader>

      {decisions.length === 0 ? (
        <p className="text-sm text-neutral-600">No recent decisions</p>
      ) : (
        <div className="space-y-1">
          {decisions.map((d, i) => {
            const isTrade = d.decision === "LONG" || d.decision === "SHORT";
            const tier = deriveTier(d.alert_type);
            return (
              <div key={i} className="flex items-center gap-2 text-xs py-1 border-b border-white/5">
                <span className="font-medium w-24 shrink-0">{d.symbol}</span>
                <Badge text={tier} color={tier === "STRICT" ? "blue" : "yellow"} />
                <Badge text={d.decision} color={isTrade ? "green" : "neutral"} />
                {!isTrade && d.gate_b_reason && (
                  <span className="text-neutral-600 truncate max-w-[200px]" title={d.gate_b_reason}>{d.gate_b_reason}</span>
                )}
                <span className="ml-auto shrink-0">
                  {d.telegram_sent ? (
                    <span className="text-emerald-600">TG sent</span>
                  ) : isTrade ? (
                    <span className="text-neutral-600">TG no</span>
                  ) : null}
                </span>
                <span className="text-neutral-600 shrink-0 w-16 text-right">{timeAgo(d.created_at)}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Scanner Health ─────────────────────────────────────

function ScannerSection({ health }: { health: ProdHealth | null }) {
  const runs = health?.scanner_recent ?? [];
  const lastRun = runs[0];
  const stale = lastRun
    ? Date.now() - new Date(lastRun.completed_at).getTime() > 90 * 60 * 1000
    : true;

  return (
    <section>
      <SectionHeader>Scanner Health</SectionHeader>

      {stale && (
        <div className="bg-yellow-950/60 border border-yellow-800 rounded px-3 py-2 mb-3 text-sm text-yellow-300">
          {lastRun
            ? `Last scan ${timeAgo(lastRun.completed_at)} — over 90 minutes, may be stuck`
            : "No scanner runs found"}
        </div>
      )}

      {runs.length > 0 ? (
        <div className="space-y-0">
          {runs.map((r, i) => (
            <div key={i} className="flex items-center text-xs py-1.5 border-b border-white/5 gap-3">
              <span className="text-neutral-500 w-16 shrink-0">{timeAgo(r.completed_at)}</span>
              <span>{r.symbols_scanned} symbols</span>
              <span className="text-emerald-500">{r.candidates_found} found</span>
              {r.candidates_queued != null && (
                <span className="text-blue-400">{r.candidates_queued} queued</span>
              )}
              <span className="ml-auto text-neutral-600">{(r.runtime_ms / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-neutral-600">No scanner run data</p>
      )}
    </section>
  );
}

// ── Main Dashboard ─────────────────────────────────────

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [lastFetch, setLastFetch] = useState<number>(Date.now());
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchDashboard();
      setData(result);
      setLastFetch(Date.now());
    } catch (err) {
      console.error("[dashboard] fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [refresh]);

  // Seconds-ago counter
  useEffect(() => {
    const tick = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastFetch) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [lastFetch]);

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-8 font-[family-name:var(--font-geist-mono)]">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Alchemy Signal System
            </h1>
            <div className="mt-1 flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-emerald-400 text-sm font-medium">Live</span>
              </div>
              {data?.priceSource && data.priceSource !== "none" && (
                <span className="text-[10px] text-neutral-600">prices: {data.priceSource}</span>
              )}
            </div>
          </div>
          <div className="text-right text-xs text-neutral-600">
            <div>Updated {secondsAgo}s ago</div>
            <div>Refresh every 30s</div>
            {loading && <div className="text-yellow-600 mt-1">Loading...</div>}
          </div>
        </div>

        {/* Grid layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: exec + scanner */}
          <div className="space-y-6">
            <ExecEngineSection exec={data?.exec ?? null} />
            <ScannerSection health={data?.prodHealth ?? null} />
          </div>

          {/* Center column: open positions */}
          <div className="lg:col-span-2 space-y-6">
            <OpenPositionsSection signals={data?.signals ?? []} />
            <PerformanceSection signals={data?.signals ?? []} />
            <RecentSignalsSection health={data?.prodHealth ?? null} />
          </div>
        </div>
      </div>
    </div>
  );
}
