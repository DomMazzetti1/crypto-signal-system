import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

function checkAuth(req: NextRequest): boolean {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "")
    ?? req.nextUrl.searchParams.get("secret");
  const cron = process.env.CRON_SECRET;
  const exec = process.env.EXEC_WEBHOOK_SECRET;
  if (!cron && !exec) return false;
  return secret === cron || secret === exec;
}

interface Finding {
  category: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  recommendation: string;
  data_support: string;
}

interface ResearchResponse {
  findings?: Finding[];
  loss_streak_analysis?: string;
  parameter_changes?: { parameter: string; current: string; recommended: string; reason: string }[];
  overall_assessment?: string;
  raw?: string;
  parse_error?: boolean;
}

async function gatherData(lookbackHours: number) {
  const supabase = getSupabase();
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();

  // Resolved signals with enrichment context
  const { data: resolved } = await supabase
    .from("decisions")
    .select("symbol, alert_type, btc_regime, composite_score, vol_ratio, claude_confidence, graded_outcome, resolution_path, created_at, resolved_at, btc_4h_change, cluster_size, cluster_rank, entry_price, stop_price, signal_funding_rate, signal_funding_interval, signal_oi_delta_1h_pct, signal_oi_delta_4h_pct, signal_spread_pct, signal_btc_correlation, signal_btc_beta")
    .eq("telegram_sent", true)
    .not("graded_outcome", "is", null)
    .not("resolution_path", "in", '("PRE_LIVE_CLEANUP","EXEC_REJECTED")')
    .neq("graded_outcome", "EXEC_REJECTED")
    .gte("created_at", since)
    .order("resolved_at", { ascending: false })
    .limit(200);

  // Open positions (unresolved)
  const { data: openPositions } = await supabase
    .from("decisions")
    .select("symbol, alert_type, btc_regime, composite_score, vol_ratio, created_at, entry_price, stop_price")
    .eq("telegram_sent", true)
    .is("graded_outcome", null)
    .order("created_at", { ascending: false })
    .limit(20);

  // All-time stats for context
  const { data: allResolved } = await supabase
    .from("decisions")
    .select("symbol, graded_outcome, resolution_path, vol_ratio, composite_score, btc_regime, alert_type, entry_price, stop_price, signal_funding_rate, signal_funding_interval, signal_oi_delta_1h_pct, signal_oi_delta_4h_pct, signal_spread_pct, signal_btc_correlation, signal_btc_beta")
    .eq("telegram_sent", true)
    .not("graded_outcome", "is", null)
    .not("resolution_path", "in", '("PRE_LIVE_CLEANUP","EXEC_REJECTED")')
    .neq("graded_outcome", "EXEC_REJECTED");

  // Latest market data from data collector
  const { data: latestMarket } = await supabase
    .from("market_ticker_history")
    .select("symbol, funding_rate, funding_interval_hours, open_interest_value, spread_pct, price")
    .order("ts", { ascending: false })
    .limit(44);

  // Latest derived metrics
  const { data: derivedMetrics } = await supabase
    .from("market_derived_metrics")
    .select("symbol, oi_delta_1h_pct, oi_delta_4h_pct, btc_beta_24h, btc_correlation_24h, funding_annualized_pct, avg_spread_1h_pct")
    .order("ts", { ascending: false })
    .limit(44);

  return { resolved: resolved ?? [], openPositions: openPositions ?? [], allResolved: allResolved ?? [], latestMarket: latestMarket ?? [], derivedMetrics: derivedMetrics ?? [] };
}

function buildPrompt(data: Awaited<ReturnType<typeof gatherData>>, mode: string): string {
  const { resolved, openPositions, allResolved, derivedMetrics } = data;

  // ── Pre-compute breakdowns (don't make Sonnet find these patterns) ──
  type Signal = typeof allResolved[number];
  const isWin = (s: Signal) => s.graded_outcome?.startsWith("WIN");
  const getRmult = (s: Signal) => {
    // Use new TP ladder values (1.0/2.0/3.5R) — old signals with 1.5/2.5/4.0 will be slightly off
    // but this is correct for all signals going forward
    if (s.resolution_path?.includes("TP3")) return 3.5;
    if (s.resolution_path?.includes("TP2")) return 2.0;
    if (s.resolution_path?.includes("TP1")) return 1.0;
    if (s.graded_outcome === "LOSS") return -1.0;
    return 0.0;
  };

  const withEnrichment = allResolved.filter((s: Signal) => s.signal_oi_delta_1h_pct != null);
  const totalWins = allResolved.filter(isWin).length;
  const totalLosses = allResolved.filter((s: Signal) => s.graded_outcome === "LOSS").length;
  const totalR = allResolved.reduce((sum: number, s: Signal) => sum + getRmult(s), 0);

  // Win rate by OI direction at signal time
  const oiRising = withEnrichment.filter((s: Signal) => Number(s.signal_oi_delta_1h_pct) > 0);
  const oiFalling = withEnrichment.filter((s: Signal) => Number(s.signal_oi_delta_1h_pct) <= 0);

  // Win rate by funding direction
  const fundingPos = withEnrichment.filter((s: Signal) => Number(s.signal_funding_rate) > 0);
  const fundingNeg = withEnrichment.filter((s: Signal) => Number(s.signal_funding_rate) < 0);

  // Win rate by BTC correlation
  const highCorr = withEnrichment.filter((s: Signal) => Number(s.signal_btc_correlation) > 0.5);
  const lowCorr = withEnrichment.filter((s: Signal) => Number(s.signal_btc_correlation) <= 0.5);

  function bucket(signals: Signal[]) {
    const n = signals.length;
    if (n === 0) return "no data";
    const w = signals.filter(isWin).length;
    const r = signals.reduce((s: number, sig: Signal) => s + getRmult(sig), 0);
    return `${n} trades, ${w} wins (${Math.round(w/n*100)}%), ${r.toFixed(1)}R`;
  }

  // Recent resolved table
  const recentTable = resolved.slice(0, 30).map((s: Signal) => {
    const stopDist = s.entry_price && s.stop_price
      ? ((Math.abs(Number(s.entry_price) - Number(s.stop_price)) / Number(s.entry_price)) * 100).toFixed(1)
      : "?";
    return `${s.symbol}|${s.graded_outcome}|${s.btc_regime}|${s.composite_score ?? "?"}|${s.vol_ratio ?? "?"}|${stopDist}%|oi1h=${s.signal_oi_delta_1h_pct ?? "?"}|fund=${s.signal_funding_rate ?? "?"}|btcCorr=${s.signal_btc_correlation ?? "?"}`;
  }).join("\n");

  // Open positions
  const openTable = openPositions.map((s: Record<string, unknown>) => {
    const stopDist = s.entry_price && s.stop_price
      ? ((Math.abs(Number(s.entry_price) - Number(s.stop_price)) / Number(s.entry_price)) * 100).toFixed(1) : "?";
    return `${s.symbol}|${s.btc_regime}|${s.composite_score ?? "?"}|${s.vol_ratio ?? "?"}|${stopDist}%`;
  }).join("\n");

  // Market snapshot from derived metrics
  const dangerousCoins = derivedMetrics
    .filter((d: typeof derivedMetrics[number]) => Math.abs(Number(d.funding_annualized_pct)) > 50 || Number(d.avg_spread_1h_pct) > 0.05)
    .map((d: typeof derivedMetrics[number]) => `${d.symbol}: fundAnn=${Number(d.funding_annualized_pct).toFixed(0)}%, spread=${Number(d.avg_spread_1h_pct).toFixed(3)}%, btcBeta=${Number(d.btc_beta_24h).toFixed(1)}, btcCorr=${Number(d.btc_correlation_24h).toFixed(2)}`)
    .join("\n");

  const highBetaCoins = derivedMetrics
    .filter((d: typeof derivedMetrics[number]) => Number(d.btc_beta_24h) > 2.0)
    .map((d: typeof derivedMetrics[number]) => `${d.symbol}: beta=${Number(d.btc_beta_24h).toFixed(1)}, corr=${Number(d.btc_correlation_24h).toFixed(2)}`)
    .join("\n");

  return `You are the quant researcher for a live crypto perpetual futures trading system (SQ_SHORT — BB squeeze detection, short-biased). TP ladder: 1.0/2.0/3.5R. Risk: 4% per trade, 2% burst.

SYSTEM STATE:
- Total resolved: ${allResolved.length} signals | ${totalWins}W ${totalLosses}L | ${totalR.toFixed(1)}R total
- Win rate: ${allResolved.length > 0 ? ((totalWins / allResolved.length) * 100).toFixed(1) : 0}%
- Open positions: ${openPositions.length}
- Signals with enrichment data: ${withEnrichment.length}
- Mode: ${mode}

PRE-COMPUTED BREAKDOWNS (from ${withEnrichment.length} enriched signals):
OI rising at signal time: ${bucket(oiRising)}
OI falling at signal time: ${bucket(oiFalling)}
Positive funding (crowd long, good for shorts): ${bucket(fundingPos)}
Negative funding (crowd short, bad for shorts): ${bucket(fundingNeg)}
High BTC correlation (>0.5): ${bucket(highCorr)}
Low BTC correlation (<=0.5): ${bucket(lowCorr)}

RECENT SIGNALS (symbol|outcome|regime|score|vol_ratio|stop%|oi1h|funding|btcCorr):
${recentTable || "No recent resolved signals"}

OPEN POSITIONS:
${openTable || "None"}

DANGEROUS COINS (extreme funding or wide spreads):
${dangerousCoins || "None"}

HIGH BTC BETA (>2x, will spike on BTC moves):
${highBetaCoins || "None"}

INSTRUCTIONS:
1. Focus on the pre-computed breakdowns. If any dimension shows a clear win/loss split, flag it.
2. Check if open positions are in dangerous coins (high funding, high beta, wide spreads).
3. Look for patterns in the recent signal sequence — regime transitions, burst clustering, time-of-day.
4. If enrichment data is sparse (signals with enrichment < 10), note this and say what you CAN conclude vs what needs more data.
5. Every recommendation must cite specific numbers from the data above.

RESPOND IN JSON ONLY (no markdown, no backticks):
{
  "findings": [{"category": "risk|signal_quality|regime|execution|correlation|new_opportunity", "severity": "critical|warning|info", "title": "short title", "detail": "what the data shows", "recommendation": "specific action", "data_support": "numbers cited"}],
  "enrichment_insights": "What the new OI/funding/correlation data reveals that was invisible before",
  "parameter_changes": [{"parameter": "name", "current": "value", "recommended": "value", "reason": "why"}],
  "overall_assessment": "1-2 sentence system health"
}`;
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mode = request.nextUrl.searchParams.get("mode") ?? "on_demand";
  const lookbackHours = mode === "weekly" ? 168 : mode === "daily" ? 24 : 168;

  try {
    console.log(`[research] Starting ${mode} analysis (${lookbackHours}h lookback)`);
    const data = await gatherData(lookbackHours);
    const prompt = buildPrompt(data, mode);

    const client = getClient();
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("");

    let findings: ResearchResponse | null = null;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      findings = JSON.parse(clean) as ResearchResponse;
    } catch {
      findings = { raw: text, parse_error: true };
    }

    // Store report
    const supabase = getSupabase();
    await supabase.from("research_reports").insert({
      report_type: mode,
      period_start: new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString(),
      period_end: new Date().toISOString(),
      signals_analyzed: data.resolved.length + data.openPositions.length,
      model_used: "claude-sonnet-4-20250514",
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      findings,
      raw_response: text,
    });

    // Telegram summary
    const emoji = mode === "weekly" ? "📊" : mode === "daily" ? "☀️" : "🔬";
    let tgMsg = `${emoji} <b>RESEARCH: ${mode.toUpperCase()}</b>\n`;

    if (findings?.overall_assessment) {
      tgMsg += `\n${findings.overall_assessment}\n`;
    }
    if (findings?.loss_streak_analysis) {
      tgMsg += `\n<b>Loss streak:</b> ${findings.loss_streak_analysis}\n`;
    }
    if (Array.isArray(findings?.findings)) {
      const critical = findings.findings.filter(f => f.severity === "critical");
      const warnings = findings.findings.filter(f => f.severity === "warning");
      const top = [...critical, ...warnings].slice(0, 4);
      if (top.length > 0) {
        tgMsg += "\n<b>Top findings:</b>\n";
        for (const f of top) {
          const icon = f.severity === "critical" ? "🔴" : "🟡";
          tgMsg += `${icon} ${f.title}\n→ ${f.recommendation}\n`;
        }
      }
    }

    if (Array.isArray(findings?.parameter_changes) && findings.parameter_changes.length > 0) {
      tgMsg += "\n<b>Parameter changes:</b>\n";
      for (const p of findings.parameter_changes.slice(0, 3)) {
        tgMsg += `• ${p.parameter}: ${p.current} → ${p.recommended}\n`;
      }
    }

    const chatId = process.env.TELEGRAM_CHAT_ID;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (chatId && botToken) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: tgMsg,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
    }

    console.log(`[research] ${mode} analysis complete. ${findings?.findings?.length ?? 0} findings. Tokens: ${response.usage?.input_tokens}in/${response.usage?.output_tokens}out`);

    return NextResponse.json({
      report_type: mode,
      signals_analyzed: data.resolved.length,
      open_positions: data.openPositions.length,
      findings,
      tokens: { input: response.usage?.input_tokens, output: response.usage?.output_tokens },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Research failed";
    console.error("[research] Failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
