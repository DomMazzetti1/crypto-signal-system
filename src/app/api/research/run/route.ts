import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabase } from "@/lib/supabase";
import { sendTelegram } from "@/lib/telegram";

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

async function gatherData(lookbackHours: number) {
  const supabase = getSupabase();
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();

  // Resolved signals in the period
  const { data: resolved } = await supabase
    .from("decisions")
    .select("symbol, alert_type, btc_regime, composite_score, vol_ratio, claude_confidence, graded_outcome, resolution_path, created_at, resolved_at, btc_4h_change, cluster_size, cluster_rank, entry_price, stop_price")
    .eq("telegram_sent", true)
    .not("graded_outcome", "is", null)
    .not("resolution_path", "in", '("PRE_LIVE_CLEANUP","EXEC_REJECTED")')
    .neq("graded_outcome", "EXEC_REJECTED")
    .gte("created_at", since)
    .order("resolved_at", { ascending: false })
    .limit(100);

  // Open positions (unresolved)
  const { data: openPositions } = await supabase
    .from("decisions")
    .select("symbol, alert_type, btc_regime, composite_score, vol_ratio, created_at, entry_price, stop_price")
    .eq("telegram_sent", true)
    .is("graded_outcome", null)
    .order("created_at", { ascending: false })
    .limit(20);

  // All-time stats for context
  const { data: allTimeStats } = await supabase.rpc("exec_sql", { query: "" }).maybeSingle();
  // Fallback: compute stats inline
  const { data: allResolved } = await supabase
    .from("decisions")
    .select("graded_outcome, resolution_path, vol_ratio, composite_score, btc_regime, alert_type")
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

  return { resolved: resolved ?? [], openPositions: openPositions ?? [], allResolved: allResolved ?? [], latestMarket: latestMarket ?? [] };
}

function buildPrompt(data: Awaited<ReturnType<typeof gatherData>>, mode: string): string {
  const { resolved, openPositions, allResolved, latestMarket } = data;

  // Compute summary stats
  const wins = allResolved.filter(s => s.resolution_path?.includes("TP1"));
  const losses = allResolved.filter(s => s.graded_outcome === "LOSS");
  const totalR = allResolved.reduce((sum, s) => {
    if (s.resolution_path?.includes("TP3")) return sum + 4;
    if (s.resolution_path?.includes("TP2")) return sum + 2.5;
    if (s.resolution_path?.includes("TP1")) return sum + 1.5;
    if (s.graded_outcome === "LOSS") return sum - 1;
    return sum;
  }, 0);

  // Recent resolved as compact table
  const recentTable = resolved.slice(0, 30).map(s => {
    const stopDist = s.entry_price && s.stop_price
      ? ((Math.abs(s.entry_price - s.stop_price) / s.entry_price) * 100).toFixed(1)
      : "?";
    return `${s.symbol}|${s.graded_outcome}|${s.btc_regime}|${s.composite_score ?? "?"}|${s.vol_ratio ?? "?"}|${stopDist}%|${s.cluster_rank ?? "?"}/${s.cluster_size ?? "?"}`;
  }).join("\n");

  const openTable = openPositions.map(s => {
    const stopDist = s.entry_price && s.stop_price
      ? ((Math.abs(s.entry_price - s.stop_price) / s.entry_price) * 100).toFixed(1)
      : "?";
    return `${s.symbol}|${s.btc_regime}|${s.composite_score ?? "?"}|${s.vol_ratio ?? "?"}|${stopDist}%`;
  }).join("\n");

  // Market context from data collector
  const fundingAlerts = latestMarket
    .filter(m => m.funding_interval_hours === 1 || Math.abs(m.funding_rate) > 0.001)
    .map(m => `${m.symbol}: rate=${m.funding_rate} interval=${m.funding_interval_hours}h`)
    .join("\n");

  const wideSpread = latestMarket
    .filter(m => m.spread_pct && parseFloat(m.spread_pct) > 0.05)
    .map(m => `${m.symbol}: ${parseFloat(m.spread_pct).toFixed(3)}%`)
    .join("\n");

  return `You are the quant researcher for a live crypto perpetual futures trading system (SQ_SHORT — BB squeeze detection, short-biased).

SYSTEM STATE:
- Total resolved signals: ${allResolved.length}
- Win rate (hit TP1+): ${allResolved.length > 0 ? ((wins.length / allResolved.length) * 100).toFixed(1) : 0}%
- Total R: ${totalR.toFixed(1)}
- Wins: ${wins.length}, Losses: ${losses.length}
- Currently open: ${openPositions.length} positions
- Mode: ${mode} analysis

RECENT SIGNALS (symbol|outcome|regime|score|vol_ratio|stop_dist|rank/burst_size):
${recentTable || "No recent resolved signals"}

OPEN POSITIONS (symbol|regime|score|vol_ratio|stop_dist):
${openTable || "No open positions"}

MARKET CONTEXT:
Dangerous funding rates (hourly or extreme):
${fundingAlerts || "None detected"}

Wide spreads (>0.05%):
${wideSpread || "None"}

ANALYZE AND RESPOND IN JSON ONLY (no markdown, no backticks):
{
  "findings": [
    {
      "category": "risk|signal_quality|regime|execution|correlation|new_opportunity",
      "severity": "critical|warning|info",
      "title": "short finding title",
      "detail": "what you found in the data",
      "recommendation": "specific action to take",
      "data_support": "which data points support this finding"
    }
  ],
  "loss_streak_analysis": "If there are consecutive losses, explain the likely cause and whether to pause trading",
  "parameter_changes": [
    {"parameter": "name", "current": "value", "recommended": "value", "reason": "why"}
  ],
  "overall_assessment": "1-2 sentence system health summary"
}

Focus on ACTIONABLE findings. No generic advice. Every finding must reference specific data from above.`;
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

    let findings: any = null;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      findings = JSON.parse(clean);
    } catch {
      console.warn("[research] Failed to parse JSON response");
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
      const critical = findings.findings.filter((f: Finding) => f.severity === "critical");
      const warnings = findings.findings.filter((f: Finding) => f.severity === "warning");
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
  } catch (err: any) {
    console.error("[research] Failed:", err);
    return NextResponse.json({ error: err.message ?? "Research failed" }, { status: 500 });
  }
}
