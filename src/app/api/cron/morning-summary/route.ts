import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { sendTelegram } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const EXEC_URL = process.env.EXEC_ENGINE_URL ?? "http://45.77.33.123:3001";

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function estimateR(outcome: string): number {
  if (outcome === "WIN_FULL" || outcome === "WIN_TP2" || outcome === "WIN_TP3") return 2.5;
  if (outcome === "WIN_TP1") return 1.0;
  if (outcome === "WIN_PARTIAL_THEN_SL" || outcome === "WIN_PARTIAL_EXPIRED") return 0.5;
  if (outcome === "WIN_BE" || outcome === "WIN_BREAKEVEN") return 0;
  if (outcome === "LOSS") return -1;
  if (outcome.startsWith("WIN")) return 0.5;
  return 0;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getSupabase();
  const now = new Date();

  // EDT = UTC-4
  const edtOffset = -4;
  const edtDate = new Date(now.getTime() + edtOffset * 60 * 60 * 1000);
  const dateStr = edtDate.toISOString().slice(0, 10);
  const timeStr = edtDate.toISOString().slice(11, 16);

  // ── Exec engine health ──
  let equity = "--";
  let openExecPositions = "--";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${EXEC_URL}/health`, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timeout);
    if (res.ok) {
      const h = await res.json();
      equity = h.account_equity != null ? `$${Number(h.account_equity).toFixed(2)}` : "--";
      openExecPositions = String(h.open_positions ?? 0);
    }
  } catch {
    // Engine unreachable — use fallback
  }

  // ── Overnight graded signals (last 12h, telegram_sent) ──
  const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const { data: overnightRaw } = await supabase
    .from("decisions")
    .select("graded_outcome")
    .eq("telegram_sent", true)
    .not("graded_outcome", "is", null)
    .gte("created_at", twelveHoursAgo);

  const overnight = overnightRaw ?? [];
  const overnightWins = overnight.filter(d => String(d.graded_outcome).startsWith("WIN")).length;
  const overnightLosses = overnight.filter(d => d.graded_outcome === "LOSS").length;
  const overnightR = overnight.reduce((sum, d) => sum + estimateR(String(d.graded_outcome)), 0);

  // ── Overall performance (all time, telegram_sent + graded) ──
  const { data: allGradedRaw } = await supabase
    .from("decisions")
    .select("graded_outcome")
    .eq("telegram_sent", true)
    .not("graded_outcome", "is", null);

  const allGraded = allGradedRaw ?? [];
  const totalWins = allGraded.filter(d => String(d.graded_outcome).startsWith("WIN")).length;
  const winRate = allGraded.length > 0 ? ((totalWins / allGraded.length) * 100).toFixed(0) : "--";
  const totalR = allGraded.reduce((sum, d) => sum + estimateR(String(d.graded_outcome)), 0);
  const avgR = allGraded.length > 0 ? (totalR / allGraded.length).toFixed(2) : "--";
  const winR = allGraded.filter(d => String(d.graded_outcome).startsWith("WIN"))
    .reduce((sum, d) => sum + Math.max(0, estimateR(String(d.graded_outcome))), 0);
  const lossR = allGraded.filter(d => d.graded_outcome === "LOSS")
    .reduce((sum, d) => sum + Math.abs(estimateR(String(d.graded_outcome))), 0);
  const pf = lossR > 0 ? (winR / lossR).toFixed(2) : totalWins > 0 ? "inf" : "--";

  // ── Open positions (telegram_sent, not graded) ──
  const { data: openRaw } = await supabase
    .from("decisions")
    .select("symbol, decision, entry_price, stop_price, tp1_price, created_at")
    .eq("telegram_sent", true)
    .is("graded_outcome", null)
    .in("decision", ["LONG", "SHORT", "MR_LONG", "MR_SHORT"])
    .order("created_at", { ascending: false });

  const openPositions = openRaw ?? [];

  // Fetch current prices for open positions via Bybit public ticker
  const priceMap = new Map<string, number>();
  if (openPositions.length > 0) {
    try {
      const res = await fetch("https://api.bybit.com/v5/market/tickers?category=linear", { cache: "no-store" });
      const data = await res.json();
      if (data.retCode === 0) {
        for (const t of (data.result?.list ?? [])) {
          const p = parseFloat(t.markPrice);
          if (Number.isFinite(p)) priceMap.set(t.symbol, p);
        }
      }
    } catch { /* best effort */ }
  }

  const openLines = openPositions.slice(0, 8).map(p => {
    const current = priceMap.get(p.symbol);
    const entry = Number(p.entry_price);
    const stop = Number(p.stop_price);
    const risk = Math.abs(entry - stop);
    const isLong = p.decision === "LONG" || p.decision === "MR_LONG";
    let rStr = "--";
    let curStr = "--";
    if (current != null) {
      curStr = fmtPrice(current);
      if (risk > 0) {
        const r = isLong ? (current - entry) / risk : (entry - current) / risk;
        rStr = `${r >= 0 ? "+" : ""}${r.toFixed(2)}`;
      }
    }
    return `${p.symbol} ${p.decision} entry=${fmtPrice(entry)} current=${curStr} R=${rStr}`;
  }).join("\n");

  // ── Next grading (soonest to 48h expiry) ──
  const nextGrading = openPositions
    .map(p => {
      const hoursOpen = (now.getTime() - new Date(p.created_at).getTime()) / (1000 * 60 * 60);
      return { symbol: p.symbol, hours_left: Math.max(0, 48 - hoursOpen) };
    })
    .sort((a, b) => a.hours_left - b.hours_left)
    .slice(0, 3);

  const nextGradingLines = nextGrading.length > 0
    ? nextGrading.map(g => `${g.symbol} — ${g.hours_left.toFixed(1)}h left`).join("\n")
    : "No pending signals";

  // ── Last scanner run ──
  const { data: lastScan } = await supabase
    .from("scanner_runs")
    .select("completed_at")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const scanMinsAgo = lastScan?.completed_at
    ? Math.round((now.getTime() - new Date(lastScan.completed_at).getTime()) / 60000)
    : null;

  // ── Build message ──
  const msg = `\u{1F305} <b>Alchemy Morning Summary</b>
\u{1F4C5} ${dateStr} \u{00B7} ${timeStr} EDT

<b>Account</b>
\u{1F4B0} Equity: ${equity}
\u{1F4C8} Open positions: ${openExecPositions}

<b>Overnight signals</b> (last 12h graded)
\u{2705} Wins: ${overnightWins} | \u{274C} Losses: ${overnightLosses} | R: ${overnightR >= 0 ? "+" : ""}${overnightR.toFixed(2)}

<b>Overall performance</b>
\u{1F3AF} Win rate: ${winRate}% (${allGraded.length} graded)
\u{1F4CA} Profit factor: ${pf} | Avg R: ${avgR}

<b>Open positions</b>
${openLines || "No open positions"}

<b>Next grading</b>
${nextGradingLines}

\u{1F504} Scanner: last run ${scanMinsAgo != null ? `${scanMinsAgo} mins ago` : "unknown"}`;

  const sent = await sendTelegram(msg);

  return NextResponse.json({
    sent,
    overnight: { wins: overnightWins, losses: overnightLosses, r: overnightR },
    overall: { graded: allGraded.length, win_rate: winRate, pf, avg_r: avgR },
    open_positions: openPositions.length,
  });
}
