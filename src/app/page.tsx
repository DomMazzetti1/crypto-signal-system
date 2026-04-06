import { headers } from "next/headers";
import { estimateLadderR, isPositiveOutcome } from "@/lib/outcome-estimates";
import DashboardAutoRefresh from "@/app/dashboard-auto-refresh";

const REFRESH_INTERVAL = 30_000;
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface LiveAccountPosition {
  symbol: string;
  sync_status: "SYNCED" | "EXCHANGE_ONLY" | "ENGINE_ONLY";
  source: string | null;
  side: string | null;
  direction: string | null;
  engine_status: string | null;
  decision_id: string | null;
  entry_price: number | null;
  mark_price: number | null;
  stop_price: number | null;
  tp1_price: number | null;
  tp2_price: number | null;
  tp3_price: number | null;
  unrealized_pnl: number | null;
  notional_usd: number | null;
  size: number | null;
  remaining_qty: number | null;
  opened_at: string | null;
  close_reason: string | null;
  tp1_hit: boolean;
  tp2_hit: boolean;
  tp3_hit: boolean;
}

interface LiveAccountSnapshot {
  status: string;
  source?: string;
  mode?: string;
  fetched_at?: string;
  uptime?: number;
  started_at?: string;
  signals_this_hour?: number;
  last_bybit_success?: string | null;
  bybit_stale?: boolean;
  error?: string;
  account?: {
    equity_usd: number;
    available_balance: number;
    used_balance: number;
    total_initial_margin?: number | null;
    available_balance_source?: string;
    balance_coin?: string | null;
    margin_mode?: string | null;
    bybit_open_positions: number;
    engine_open_positions: number;
  };
  sync?: {
    matched_positions: number;
    exchange_only_positions: number;
    engine_only_positions: number;
    exchange_only_symbols: string[];
    engine_only_symbols: string[];
  };
  positions?: LiveAccountPosition[];
}

interface Signal {
  id: string;
  symbol: string;
  decision: string;
  alert_type: string;
  created_at: string;
  entry_price: number | null;
  stop_price: number | null;
  tp1_price: number | null;
  tp2_price: number | null;
  tp3_price: number | null;
  current_price: number | null;
  graded_outcome: string | null;
  resolution_path?: string | null;
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
  generated_at?: string;
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
  account: LiveAccountSnapshot | null;
  signals: Signal[];
  prodHealth: ProdHealth | null;
  priceSource: string;
}

interface ActiveSignalsResponse {
  signals?: Signal[];
  price_source?: string;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h ago`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "--";
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "--";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(n) >= 1000 ? 2 : 2,
  })}`;
}

function fmtSignedUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "--";
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function fmtQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "--";
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

function fmtUptime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "--";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtEnumLabel(value: string | null | undefined): string {
  if (!value) return "--";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function deriveTier(alertType: string): string {
  if (/_RELAXED$/i.test(alertType)) return "RELAXED";
  if (/_DATA$/i.test(alertType)) return "DATA";
  return "STRICT";
}

function isLongDirection(direction: string | null | undefined, side?: string | null): boolean {
  if (direction === "LONG" || direction === "MR_LONG") return true;
  if (direction === "SHORT" || direction === "MR_SHORT") return false;
  return side === "Buy";
}

function computeCurrentR(
  direction: string | null | undefined,
  entry: number | null | undefined,
  stop: number | null | undefined,
  current: number | null | undefined,
  side?: string | null
): number | null {
  if (entry == null || stop == null || current == null) return null;
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk === 0) return null;
  const isLong = isLongDirection(direction, side);
  const pnl = isLong ? current - entry : entry - current;
  return pnl / risk;
}

function progressToTarget(
  direction: string | null | undefined,
  entry: number | null | undefined,
  target: number | null | undefined,
  current: number | null | undefined,
  side?: string | null
): number | null {
  if (entry == null || target == null || current == null) return null;
  const isLong = isLongDirection(direction, side);
  const total = isLong ? target - entry : entry - target;
  if (!Number.isFinite(total) || total <= 0) return null;
  const covered = isLong ? current - entry : entry - current;
  return Math.max(0, Math.min(100, (covered / total) * 100));
}

function requestBaseUrl(): string {
  const headerStore = headers();
  const host =
    headerStore.get("x-forwarded-host") ??
    headerStore.get("host") ??
    "crypto-signal-system.vercel.app";
  const proto =
    headerStore.get("x-forwarded-proto") ??
    (host.includes("localhost") ? "http" : "https");

  return `${proto}://${host}`;
}

async function fetchRouteJson<T>(baseUrl: string, path: string): Promise<T | null> {
  try {
    const res = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function fetchDashboard(): Promise<DashboardData> {
  const baseUrl = requestBaseUrl();
  const [account, signalsRes, prodHealth] = await Promise.all([
    fetchRouteJson<LiveAccountSnapshot>(baseUrl, "/api/dashboard/live-account"),
    fetchRouteJson<ActiveSignalsResponse>(baseUrl, "/api/dashboard/active-signals?hours=720"),
    fetchRouteJson<ProdHealth>(baseUrl, "/api/dashboard/production-health"),
  ]);

  return {
    account,
    signals: signalsRes?.signals ?? [],
    prodHealth,
    priceSource: signalsRes?.price_source ?? "none",
  };
}

function SectionShell({
  children,
  accent = "slate",
}: {
  children: React.ReactNode;
  accent?: "slate" | "emerald" | "amber" | "rose";
}) {
  const accents: Record<string, string> = {
    slate: "border-white/10 bg-white/[0.03]",
    emerald: "border-emerald-500/20 bg-emerald-500/[0.06]",
    amber: "border-amber-500/20 bg-amber-500/[0.06]",
    rose: "border-rose-500/20 bg-rose-500/[0.06]",
  };

  return (
    <section className={`rounded-3xl border p-5 shadow-[0_20px_80px_rgba(0,0,0,0.22)] backdrop-blur ${accents[accent] ?? accents.slate}`}>
      {children}
    </section>
  );
}

function SectionHeader({
  eyebrow,
  title,
  meta,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/45">
          {eyebrow}
        </div>
        <h2 className="mt-1 text-lg font-semibold text-white">{title}</h2>
      </div>
      {meta ? <div className="text-xs text-white/45">{meta}</div> : null}
    </div>
  );
}

function Badge({
  text,
  tone = "slate",
}: {
  text: string;
  tone?: "slate" | "emerald" | "amber" | "rose" | "cyan";
}) {
  const tones: Record<string, string> = {
    slate: "border-white/10 bg-white/5 text-white/70",
    emerald: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
    amber: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    rose: "border-rose-400/25 bg-rose-400/10 text-rose-200",
    cyan: "border-cyan-400/25 bg-cyan-400/10 text-cyan-200",
  };

  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${tones[tone] ?? tones.slate}`}>
      {text}
    </span>
  );
}

function HeroMetric({
  label,
  value,
  hint,
  tone = "slate",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "slate" | "emerald" | "amber" | "rose";
}) {
  const tones: Record<string, string> = {
    slate: "from-white/10 to-white/0",
    emerald: "from-emerald-500/18 to-emerald-500/0",
    amber: "from-amber-500/18 to-amber-500/0",
    rose: "from-rose-500/18 to-rose-500/0",
  };

  return (
    <div className={`rounded-2xl border border-white/10 bg-gradient-to-br ${tones[tone] ?? tones.slate} p-4`}>
      <div className="text-[11px] uppercase tracking-[0.2em] text-white/45">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
      {hint ? <div className="mt-1 text-xs text-white/45">{hint}</div> : null}
    </div>
  );
}

function AccountHero({
  account,
  loading,
}: {
  account: LiveAccountSnapshot | null;
  loading: boolean;
}) {
  const accountState = account?.account;
  const sync = account?.sync;
  const syncIssues = (sync?.exchange_only_positions ?? 0) + (sync?.engine_only_positions ?? 0);
  const stale = account?.bybit_stale === true;
  const down = !loading && (!account || account.status === "down" || account.status === "error");
  const pending = loading && !account;
  const availableHint =
    accountState?.available_balance_source === "coin_derived"
      ? `derived from ${accountState.balance_coin ?? "margin"} isolated balance`
      : accountState?.available_balance_source === "fallback_zero"
        ? "Bybit did not return a usable free balance"
        : "Bybit available balance";
  const marginHint =
    accountState?.total_initial_margin != null && Number.isFinite(accountState.total_initial_margin)
      ? `initial margin ${fmtUsd(accountState.total_initial_margin)}`
      : "equity minus available";

  return (
    <SectionShell accent={down ? "rose" : stale ? "amber" : pending ? "slate" : "emerald"}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
            Live Account
          </div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white md:text-4xl">
            Alchemy Control Room
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
            Exchange truth first. The top of this page now reflects authenticated Bybit balance and open positions, while scanner and research panels stay clearly separated below.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge
            text={pending ? "Connecting" : down ? "Engine Down" : stale ? "Bybit Stale" : "Bybit Synced"}
            tone={pending ? "slate" : down ? "rose" : stale ? "amber" : "emerald"}
          />
          <Badge text={account?.mode ?? "Unknown Mode"} tone={account?.mode === "TESTNET" ? "amber" : "cyan"} />
          {accountState?.margin_mode ? <Badge text={fmtEnumLabel(accountState.margin_mode)} tone="amber" /> : null}
          {account?.source ? <Badge text={account.source} tone="slate" /> : null}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <HeroMetric
          label="Equity"
          value={fmtUsd(accountState?.equity_usd)}
          hint={account?.fetched_at ? `snapshot ${timeAgo(account.fetched_at)}` : undefined}
          tone="emerald"
        />
        <HeroMetric
          label="Available"
          value={fmtUsd(accountState?.available_balance)}
          hint={availableHint}
        />
        <HeroMetric
          label="Margin In Use"
          value={fmtUsd(accountState?.used_balance)}
          hint={marginHint}
          tone="amber"
        />
        <HeroMetric
          label="Open Positions"
          value={String(accountState?.bybit_open_positions ?? 0)}
          hint={`engine sees ${accountState?.engine_open_positions ?? 0}`}
        />
        <HeroMetric
          label="Sync Issues"
          value={String(syncIssues)}
          hint={syncIssues > 0 ? "Bybit vs engine mismatch" : "engine aligned with exchange"}
          tone={syncIssues > 0 ? "rose" : "slate"}
        />
      </div>
    </SectionShell>
  );
}

function AccountStatusSection({
  account,
  loading,
}: {
  account: LiveAccountSnapshot | null;
  loading: boolean;
}) {
  const down = !loading && (!account || account.status === "down" || account.status === "error");
  const stale = account?.bybit_stale === true;
  const sync = account?.sync;

  return (
    <SectionShell accent={down ? "rose" : stale ? "amber" : "slate"}>
      <SectionHeader
        eyebrow="Engine"
        title="Execution Status"
        meta={account?.last_bybit_success ? `last success ${timeAgo(account.last_bybit_success)}` : undefined}
      />

      {loading && !account ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/70">
          Loading the authenticated Bybit snapshot from the execution engine.
        </div>
      ) : down ? (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-100">
          Unable to reach the authenticated Bybit snapshot route.
          <div className="mt-2 text-rose-100/70">{account?.error ?? "No response from execution engine"}</div>
        </div>
      ) : (
        <div className="space-y-3">
          {stale ? (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
              Bybit data is stale. The engine is up, but the last successful private API roundtrip is older than two minutes.
            </div>
          ) : null}

          {(sync?.exchange_only_positions ?? 0) > 0 || (sync?.engine_only_positions ?? 0) > 0 ? (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-100">
              {sync?.exchange_only_positions ?? 0} exchange-only and {sync?.engine_only_positions ?? 0} engine-only position mismatch
              {(sync?.exchange_only_symbols?.length ?? 0) > 0 ? (
                <div className="mt-2 text-rose-100/70">
                  Exchange only: {sync?.exchange_only_symbols.join(", ")}
                </div>
              ) : null}
              {(sync?.engine_only_symbols?.length ?? 0) > 0 ? (
                <div className="mt-1 text-rose-100/70">
                  Engine only: {sync?.engine_only_symbols.join(", ")}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 text-sm text-white/70">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Mode</div>
              <div className="mt-1 font-medium text-white">{account?.mode ?? "--"}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Margin Mode</div>
              <div className="mt-1 font-medium text-white">{fmtEnumLabel(account?.account?.margin_mode)}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Uptime</div>
              <div className="mt-1 font-medium text-white">{fmtUptime(account?.uptime)}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Signals This Hour</div>
              <div className="mt-1 font-medium text-white">{account?.signals_this_hour ?? 0}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Balance Source</div>
              <div className="mt-1 font-medium text-white">
                {account?.account?.available_balance_source === "coin_derived"
                  ? `${account.account.balance_coin ?? "Margin"} Derived`
                  : account?.account?.available_balance_source === "account_total"
                    ? "Account Total"
                    : account?.account?.available_balance_source === "fallback_zero"
                      ? "Unavailable"
                      : "--"}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Started</div>
              <div className="mt-1 font-medium text-white">
                {account?.started_at ? timeAgo(account.started_at) : "--"}
              </div>
            </div>
          </div>
        </div>
      )}
    </SectionShell>
  );
}

function LivePositionsSection({ account }: { account: LiveAccountSnapshot | null }) {
  const positions = [...(account?.positions ?? [])].sort((a, b) => {
    const syncRank = (value: LiveAccountPosition["sync_status"]) =>
      value === "SYNCED" ? 0 : value === "EXCHANGE_ONLY" ? 1 : 2;
    const syncDiff = syncRank(a.sync_status) - syncRank(b.sync_status);
    if (syncDiff !== 0) return syncDiff;
    return Math.abs(b.unrealized_pnl ?? 0) - Math.abs(a.unrealized_pnl ?? 0);
  });

  return (
    <SectionShell accent="slate">
      <SectionHeader
        eyebrow="Positions"
        title={`Bybit Open Positions (${positions.filter((p) => p.sync_status !== "ENGINE_ONLY").length})`}
        meta={account?.fetched_at ? `snapshot ${timeAgo(account.fetched_at)}` : undefined}
      />

      {positions.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-5 text-sm text-white/55">
          No live positions on the exchange.
        </div>
      ) : (
        <div className="space-y-3">
          {positions.map((position) => {
            const currentR = computeCurrentR(
              position.direction,
              position.entry_price,
              position.stop_price,
              position.mark_price,
              position.side
            );
            const progress = progressToTarget(
              position.direction,
              position.entry_price,
              position.tp1_price,
              position.mark_price,
              position.side
            );
            const isPositive =
              (position.unrealized_pnl ?? 0) > 0 || (currentR != null && currentR > 0);
            const syncTone =
              position.sync_status === "SYNCED"
                ? "emerald"
                : position.sync_status === "EXCHANGE_ONLY"
                  ? "amber"
                  : "rose";

            return (
              <div
                key={position.symbol}
                className="rounded-2xl border border-white/10 bg-black/25 p-4"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-lg font-semibold text-white">{position.symbol}</div>
                      {position.direction ? (
                        <Badge
                          text={position.direction}
                          tone={isLongDirection(position.direction, position.side) ? "emerald" : "rose"}
                        />
                      ) : null}
                      <Badge text={position.sync_status.replace("_", " ")} tone={syncTone} />
                      {position.engine_status ? (
                        <Badge text={position.engine_status} tone="slate" />
                      ) : null}
                    </div>
                    <div className="mt-2 text-sm text-white/50">
                      {position.sync_status === "EXCHANGE_ONLY"
                        ? "Live on Bybit, but not tracked in the engine state."
                        : position.sync_status === "ENGINE_ONLY"
                          ? "Tracked by the engine, but missing from the current Bybit position list."
                          : `Tracked locally${position.opened_at ? ` since ${timeAgo(position.opened_at)}` : ""}.`}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className={`text-xl font-semibold ${isPositive ? "text-emerald-300" : "text-rose-300"}`}>
                      {fmtSignedUsd(position.unrealized_pnl)}
                    </div>
                    <div className="text-xs text-white/45">unrealized PnL</div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-6">
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Entry</div>
                    <div className="mt-1 font-medium text-white">{fmtPrice(position.entry_price)}</div>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Mark</div>
                    <div className={`mt-1 font-medium ${isPositive ? "text-emerald-200" : "text-rose-200"}`}>
                      {fmtPrice(position.mark_price)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Stop</div>
                    <div className="mt-1 font-medium text-white">{fmtPrice(position.stop_price)}</div>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">R</div>
                    <div className={`mt-1 font-medium ${currentR != null && currentR >= 0 ? "text-emerald-200" : "text-rose-200"}`}>
                      {currentR != null ? `${currentR >= 0 ? "+" : ""}${currentR.toFixed(2)}` : "--"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Notional</div>
                    <div className="mt-1 font-medium text-white">{fmtUsd(position.notional_usd)}</div>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Size</div>
                    <div className="mt-1 font-medium text-white">{fmtQty(position.size)}</div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-[0.16em] text-white/40">TP1</span>
                      {position.tp1_hit ? <Badge text="Hit" tone="emerald" /> : null}
                    </div>
                    <div className="mt-1 font-medium text-white">{fmtPrice(position.tp1_price)}</div>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-[0.16em] text-white/40">TP2</span>
                      {position.tp2_hit ? <Badge text="Hit" tone="emerald" /> : null}
                    </div>
                    <div className="mt-1 font-medium text-white">{fmtPrice(position.tp2_price)}</div>
                  </div>
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-[0.16em] text-white/40">TP3</span>
                      {position.tp3_hit ? <Badge text="Hit" tone="emerald" /> : null}
                    </div>
                    <div className="mt-1 font-medium text-white">{fmtPrice(position.tp3_price)}</div>
                  </div>
                </div>

                <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/8">
                  <div
                    className={`h-full rounded-full ${isPositive ? "bg-emerald-400" : "bg-rose-400"}`}
                    style={{ width: `${progress ?? 0}%` }}
                  />
                </div>
                <div className="mt-1 text-[11px] text-white/45">
                  {progress != null ? `${progress.toFixed(0)}% of the move to TP1` : "TP progress unavailable"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionShell>
  );
}

function PerformanceSection({
  signals,
  priceSource,
}: {
  signals: Signal[];
  priceSource: string;
}) {
  const graded = signals.filter((signal) => signal.telegram_sent && signal.graded_outcome);
  const wins = graded.filter((signal) =>
    isPositiveOutcome(signal.graded_outcome, signal.resolution_path)
  );
  const losses = graded.filter(
    (signal) => estimateLadderR(signal.graded_outcome, signal.resolution_path) < 0
  );
  const winRate = graded.length > 0 ? (wins.length / graded.length) * 100 : 0;
  const totalR = graded.reduce(
    (sum, signal) => sum + estimateLadderR(signal.graded_outcome, signal.resolution_path),
    0
  );
  const avgR = graded.length > 0 ? totalR / graded.length : 0;
  const totalWinR = wins.reduce(
    (sum, signal) =>
      sum + Math.max(0, estimateLadderR(signal.graded_outcome, signal.resolution_path)),
    0
  );
  const totalLossR = losses.reduce(
    (sum, signal) =>
      sum + Math.abs(estimateLadderR(signal.graded_outcome, signal.resolution_path)),
    0
  );
  const pf = totalLossR > 0 ? totalWinR / totalLossR : wins.length > 0 ? Infinity : 0;

  type DayPerf = { day: string; wins: number; losses: number; total: number };
  const dayMap = new Map<string, DayPerf>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", { weekday: "short" });
    dayMap.set(key, { day: label, wins: 0, losses: 0, total: 0 });
  }
  for (const signal of graded) {
    const key = signal.created_at.slice(0, 10);
    const entry = dayMap.get(key);
    if (!entry) continue;
    entry.total++;
    const estimatedR = estimateLadderR(signal.graded_outcome, signal.resolution_path);
    if (estimatedR > 0) entry.wins++;
    else if (estimatedR < 0) entry.losses++;
  }
  const days = Array.from(dayMap.values());
  const maxDay = Math.max(...days.map((day) => day.total), 1);

  return (
    <SectionShell accent="slate">
      <SectionHeader
        eyebrow="Research"
        title="Telegram Signal Performance"
        meta={priceSource !== "none" ? `supporting live prices: ${priceSource}` : "price support unavailable"}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <HeroMetric label="Graded" value={String(graded.length)} />
        <HeroMetric label="Win Rate" value={`${winRate.toFixed(1)}%`} tone="emerald" />
        <HeroMetric label="Avg R" value={avgR.toFixed(2)} />
        <HeroMetric label="PF" value={pf === Infinity ? "inf" : pf.toFixed(2)} />
        <HeroMetric
          label="Total R"
          value={`${totalR >= 0 ? "+" : ""}${totalR.toFixed(1)}`}
          tone={totalR >= 0 ? "emerald" : "rose"}
        />
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/40">
          Last 7 Days
        </div>
        <div className="flex h-20 items-end gap-2">
          {days.map((day) => (
            <div key={day.day} className="flex flex-1 flex-col items-center">
              <div className="flex h-14 w-full flex-col justify-end rounded-xl bg-white/[0.03] p-1">
                {day.total > 0 ? (
                  <div className="flex h-full flex-col justify-end gap-0.5">
                    <div
                      className="rounded-md bg-rose-400/70"
                      style={{ height: `${(day.losses / maxDay) * 100}%` }}
                    />
                    <div
                      className="rounded-md bg-emerald-400/80"
                      style={{ height: `${(day.wins / maxDay) * 100}%` }}
                    />
                  </div>
                ) : null}
              </div>
              <div className="mt-2 text-[10px] text-white/45">{day.day}</div>
            </div>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}

function RecentSignalsSection({ health }: { health: ProdHealth | null }) {
  const decisions = health?.recent_decisions?.slice(0, 10) ?? [];

  return (
    <SectionShell accent="slate">
      <SectionHeader eyebrow="Pipeline" title="Recent Decisions" />

      {decisions.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/55">
          No recent decisions found.
        </div>
      ) : (
        <div className="space-y-2">
          {decisions.map((decision, index) => {
            const isTrade = decision.decision === "LONG" || decision.decision === "SHORT";
            const tier = deriveTier(decision.alert_type);
            return (
              <div
                key={`${decision.symbol}-${index}`}
                className="flex flex-col gap-2 rounded-2xl border border-white/8 bg-white/[0.025] p-3 md:flex-row md:items-center"
              >
                <div className="min-w-[84px] text-sm font-semibold text-white">{decision.symbol}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge text={tier} tone={tier === "STRICT" ? "cyan" : "amber"} />
                  <Badge text={decision.decision} tone={isTrade ? "emerald" : "slate"} />
                  {decision.telegram_sent ? <Badge text="Telegram" tone="emerald" /> : null}
                </div>
                <div className="text-sm text-white/50 md:ml-2 md:flex-1">
                  {!isTrade && decision.gate_b_reason ? decision.gate_b_reason : "passed through pipeline"}
                </div>
                <div className="text-xs text-white/40">{timeAgo(decision.created_at)}</div>
              </div>
            );
          })}
        </div>
      )}
    </SectionShell>
  );
}

function ScannerSection({ health }: { health: ProdHealth | null }) {
  const runs = health?.scanner_recent ?? [];
  const lastRun = runs[0];
  const stale = lastRun
    ? Date.now() - new Date(lastRun.completed_at).getTime() > 90 * 60 * 1000
    : true;

  return (
    <SectionShell accent={stale ? "amber" : "slate"}>
      <SectionHeader
        eyebrow="Scanner"
        title="Scan Cadence"
        meta={lastRun ? `last run ${timeAgo(lastRun.completed_at)}` : undefined}
      />

      {stale ? (
        <div className="mb-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
          {lastRun
            ? "Last scan is older than 90 minutes, so the scanner may be stuck."
            : "No scanner runs were found."}
        </div>
      ) : null}

      {runs.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/55">
          No scanner telemetry available.
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run, index) => (
            <div
              key={`${run.completed_at}-${index}`}
              className="grid grid-cols-2 gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3 text-sm md:grid-cols-4"
            >
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Completed</div>
                <div className="mt-1 text-white">{timeAgo(run.completed_at)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Scanned</div>
                <div className="mt-1 text-white">{run.symbols_scanned}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Found</div>
                <div className="mt-1 text-white">{run.candidates_found}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">Runtime</div>
                <div className="mt-1 text-white">{(run.runtime_ms / 1000).toFixed(1)}s</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

export default async function Home() {
  const data = await fetchDashboard();
  const lastFetchMs = data.account?.fetched_at
    ? new Date(data.account.fetched_at).getTime()
    : data.prodHealth?.generated_at
      ? new Date(data.prodHealth.generated_at).getTime()
      : Date.now();
  const secondsAgo = Math.max(0, Math.floor((Date.now() - lastFetchMs) / 1000));
  const loading = false;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(245,158,11,0.16),_transparent_24%),linear-gradient(180deg,_#071116_0%,_#0b0f19_36%,_#05070d_100%)] px-4 py-6 text-white md:px-8 md:py-10">
      <DashboardAutoRefresh intervalMs={REFRESH_INTERVAL} />
      <div className="mx-auto max-w-7xl">
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="text-sm text-white/45">
            Updated {secondsAgo}s ago
            <span className="mx-2 text-white/20">•</span>
            refresh every 30s
            <span className="mx-2 text-white/20">•</span>
            <span className="text-white/55">server-rendered snapshot</span>
          </div>
          <a
            href="/dashboard/signals"
            className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/75 transition hover:bg-white/[0.08]"
          >
            Open Signal Detail View
          </a>
        </div>

        <div className="space-y-6">
          <AccountHero account={data?.account ?? null} loading={loading} />

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.05fr_1.95fr]">
            <div className="space-y-6">
              <AccountStatusSection account={data?.account ?? null} loading={loading} />
              <ScannerSection health={data?.prodHealth ?? null} />
            </div>
            <LivePositionsSection account={data?.account ?? null} />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_0.85fr]">
            <PerformanceSection
              signals={data?.signals ?? []}
              priceSource={data?.priceSource ?? "none"}
            />
            <RecentSignalsSection health={data?.prodHealth ?? null} />
          </div>
        </div>
      </div>
    </div>
  );
}
