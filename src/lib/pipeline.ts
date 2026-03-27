import { getSupabase } from "@/lib/supabase";
import { getRedis } from "@/lib/redis";
import {
  fetchTicker,
  fetchOrderbook,
  fetchOIHistory,
  fetchKlines,
  computeSpreadBps,
  computeBookDepthUsd,
  computeOIDelta,
} from "@/lib/bybit";
import { computeHTFTrend, latestATR } from "@/lib/ta";
import { classifyRegime } from "@/lib/regime";
import { runGateB } from "@/lib/gate-b";
import { calculateLevels } from "@/lib/levels";
import { isCooldownActive, setCooldown } from "@/lib/cooldown";
import { reviewWithClaude, ClaudeReviewInput } from "@/lib/reviewer";
import { buildMessage, sendTelegram } from "@/lib/telegram";

export interface AlertPayload {
  type: string;
  symbol: string;
  tf: string;
  price: number;
  rsi: number;
  adx1h: number;
  adx4h: number;
  bb_width: number;
  volume?: number;
  sma20_volume?: number;
}

interface GateAResult {
  passed: boolean;
  quality: "high" | "medium" | "low";
  rejectReason: string | null;
}

function runGateA(
  markPrice: number | null,
  turnover24h: number,
  orderbookTs: number,
  spreadBps: number
): GateAResult {
  const now = Date.now();

  if (!markPrice) {
    return { passed: false, quality: "low", rejectReason: "markPrice missing" };
  }
  if (turnover24h < 10_000_000) {
    return { passed: false, quality: "low", rejectReason: `turnover24h ${turnover24h} < 10M` };
  }
  if (now - orderbookTs > 5000) {
    return { passed: false, quality: "low", rejectReason: `orderbook stale: ${now - orderbookTs}ms` };
  }
  if (spreadBps > 15) {
    return { passed: false, quality: "low", rejectReason: `spread_bps ${spreadBps.toFixed(2)} > 15` };
  }

  if (spreadBps <= 3 && turnover24h >= 50_000_000) {
    return { passed: true, quality: "high", rejectReason: null };
  }
  if (spreadBps <= 8 && turnover24h >= 20_000_000) {
    return { passed: true, quality: "medium", rejectReason: null };
  }
  return { passed: true, quality: "low", rejectReason: null };
}

export interface PipelineResult {
  status: string;
  symbol: string;
  decision: string;
  gate_a: { passed: boolean; quality: string; reject_reason: string | null };
  gate_b?: { passed: boolean; reason: string | null };
  regime?: {
    btc_regime: string;
    alt_environment: string;
    btc_4h_trend: string;
    btc_1d_trend: string;
    btc_atr_ratio: number;
  };
  htf_trend?: {
    trend_4h: string;
    trend_1d: string;
    atr14_1h: number;
    atr14_4h: number;
  };
  levels?: {
    entry: number;
    stop: number;
    tp1: number;
    tp2: number;
    tp3: number;
    rr_tp1: number;
  };
  claude?: {
    decision: string | null;
    confidence: number | null;
    setup_type: string | null;
    risk_flags: string[];
    reasoning: string | null;
  };
  cooldown_active?: boolean;
  telegram_sent?: boolean;
  telegram_block_reason?: string | null;
  error?: string;
  http_status?: number;
}

export async function runPipeline(
  alert: AlertPayload,
  alertId: string | null
): Promise<PipelineResult> {
  const supabase = getSupabase();

  const rawType = alert.type.toLowerCase();
  const direction: "long" | "short" = rawType.includes("short") ? "short" : "long";
  const isRelaxed = rawType.includes("relaxed");
  console.log(`[pipeline] Processing: ${alert.symbol} type=${alert.type} direction=${direction}`);

  // ── 1. Enrichment: market data (parallel) ─────────────
  let ticker, orderbook, oi5m, oi15m, oi1h;
  try {
    [ticker, orderbook, oi5m, oi15m, oi1h] = await Promise.all([
      fetchTicker(alert.symbol),
      fetchOrderbook(alert.symbol),
      fetchOIHistory(alert.symbol, "5min"),
      fetchOIHistory(alert.symbol, "15min"),
      fetchOIHistory(alert.symbol, "1h"),
    ]);
  } catch (err) {
    console.error(`[pipeline] Bybit market data error for ${alert.symbol}:`, err);
    return {
      status: "error",
      symbol: alert.symbol,
      decision: "NO_TRADE",
      gate_a: { passed: false, quality: "low", reject_reason: "Market data fetch failed" },
      error: "Market data fetch failed",
      http_status: 502,
    };
  }

  const markPrice = parseFloat(ticker.markPrice);
  const turnover24h = parseFloat(ticker.turnover24h);
  const fundingRate = parseFloat(ticker.fundingRate);

  if (!Number.isFinite(markPrice) || !Number.isFinite(turnover24h)) {
    console.error(`[pipeline] Invalid ticker values for ${alert.symbol}: markPrice=${ticker.markPrice}, turnover24h=${ticker.turnover24h}`);
    return {
      status: "error",
      symbol: alert.symbol,
      decision: "NO_TRADE",
      gate_a: { passed: false, quality: "low", reject_reason: "Invalid ticker data (NaN)" },
      error: "Invalid ticker data (NaN)",
      http_status: 502,
    };
  }

  const spreadBps = computeSpreadBps(ticker.bid1Price, ticker.ask1Price);
  const bookDepthBidUsd = computeBookDepthUsd(orderbook.bids, markPrice);
  const bookDepthAskUsd = computeBookDepthUsd(orderbook.asks, markPrice);
  const oiDelta5m = computeOIDelta(oi5m);
  const oiDelta15m = computeOIDelta(oi15m);
  const oiDelta1h = computeOIDelta(oi1h);

  // ── 2. Gate A ─────────────────────────────────────────
  const gateA = runGateA(markPrice, turnover24h, orderbook.ts, spreadBps);

  // Store snapshot regardless of gate A outcome
  const { data: snapRow, error: snapError } = await supabase
    .from("market_snapshots")
    .insert({
      alert_id: alertId,
      symbol: alert.symbol,
      alert_type: alert.type,
      alert_tf: alert.tf,
      alert_price: alert.price,
      alert_rsi: alert.rsi,
      alert_adx1h: alert.adx1h,
      alert_adx4h: alert.adx4h,
      alert_bb_width: alert.bb_width,
      mark_price: markPrice,
      index_price: parseFloat(ticker.indexPrice),
      funding_rate: fundingRate,
      next_funding_time: Number.isFinite(Number(ticker.nextFundingTime))
        ? new Date(Number(ticker.nextFundingTime)).toISOString()
        : null,
      open_interest: parseFloat(ticker.openInterest),
      open_interest_value: parseFloat(ticker.openInterestValue),
      turnover_24h: turnover24h,
      bid1_price: parseFloat(ticker.bid1Price),
      ask1_price: parseFloat(ticker.ask1Price),
      spread_bps: spreadBps,
      book_depth_bid_usd: bookDepthBidUsd,
      book_depth_ask_usd: bookDepthAskUsd,
      orderbook_ts: orderbook.ts,
      oi_delta_5m: oiDelta5m,
      oi_delta_15m: oiDelta15m,
      oi_delta_1h: oiDelta1h,
      taker_buy_usd_1h: null,
      taker_sell_usd_1h: null,
      taker_imbalance_1h: null,
      flow_quality: "missing",
      snapshot_quality: gateA.quality,
      gate_a_passed: gateA.passed,
      gate_a_reject_reason: gateA.rejectReason,
    })
    .select("id")
    .single();

  if (snapError) {
    console.error("[pipeline] Failed to insert snapshot:", snapError);
    return {
      status: "error",
      symbol: alert.symbol,
      decision: "NO_TRADE",
      gate_a: { passed: false, quality: "low", reject_reason: "Snapshot insert failed" },
      error: "Snapshot insert failed",
      http_status: 500,
    };
  }

  const snapshotId: string | null = snapRow?.id ?? null;

  // Gate A is advisory — flag but don't block.
  // In data-collection mode, we want all signals to reach Gate B and beyond.
  if (!gateA.passed) {
    console.log(`[pipeline] ${alert.symbol} Gate A flagged (not blocking): ${gateA.rejectReason}`);
  }

  /* GATE A HARD BLOCK DISABLED FOR DATA COLLECTION
  if (!gateA.passed) {
    await storeDecision(supabase, {
      snapshot_id: snapshotId,
      alert_id: alertId,
      symbol: alert.symbol,
      alert_type: alert.type,
      alert_tf: alert.tf,
      decision: "NO_TRADE",
      gate_a_passed: false,
      gate_a_quality: gateA.quality,
      gate_b_passed: false,
      gate_b_reason: `Gate A rejected: ${gateA.rejectReason}`,
      trend_4h: "neutral",
      trend_1d: "neutral",
      btc_regime: "range",
      alt_environment: "mixed",
      cooldown_active: false,
    });
    await markProcessed(supabase, alertId);
    return {
      status: "decision_made",
      symbol: alert.symbol,
      decision: "NO_TRADE",
      gate_a: { passed: false, quality: gateA.quality, reject_reason: gateA.rejectReason },
    };
  }
  END GATE A HARD BLOCK */

  // ── 3. HTF Trend ──────────────────────────────────────
  let candles1h, candles4h, candles1d;
  try {
    [candles1h, candles4h, candles1d] = await Promise.all([
      fetchKlines(alert.symbol, "60", 20),
      fetchKlines(alert.symbol, "240", 50),
      fetchKlines(alert.symbol, "D", 14),
    ]);
  } catch (err) {
    console.error(`[pipeline] Kline fetch error for ${alert.symbol}:`, err);
    return {
      status: "error",
      symbol: alert.symbol,
      decision: "NO_TRADE",
      gate_a: { passed: true, quality: gateA.quality, reject_reason: null },
      error: "Kline data fetch failed",
      http_status: 502,
    };
  }

  const trend4h = computeHTFTrend(candles4h);
  const trend1d = computeHTFTrend(candles1d);
  const atr14_1h = latestATR(candles1h, 14);
  const atr14_4h = latestATR(candles4h, 14);

  // ── 4. Regime classification ──────────────────────────
  let regime;
  try {
    regime = await classifyRegime();
  } catch (err) {
    console.error("[pipeline] Regime classification error:", err);
    return {
      status: "error",
      symbol: alert.symbol,
      decision: "NO_TRADE",
      gate_a: { passed: true, quality: gateA.quality, reject_reason: null },
      error: "Regime classification failed",
      http_status: 502,
    };
  }

  // ── 5. Price levels ───────────────────────────────────
  const levels = calculateLevels(markPrice, atr14_1h, direction);

  // ── 5b. Level validation ───────────────────────────────
  if (!levels.valid) {
    console.error(`[pipeline] ${alert.symbol} INVALID LEVELS: ${levels.invalid_reason}`);
    await storeDecision(supabase, {
      snapshot_id: snapshotId,
      alert_id: alertId,
      symbol: alert.symbol,
      alert_type: alert.type,
      alert_tf: alert.tf,
      decision: "NO_TRADE",
      gate_a_passed: gateA.passed,
      gate_a_quality: gateA.quality,
      gate_b_passed: false,
      gate_b_reason: `Invalid levels: ${levels.invalid_reason}`,
      trend_4h: trend4h.trend,
      trend_1d: trend1d.trend,
      btc_regime: regime.btc_regime,
      alt_environment: regime.alt_environment,
      cooldown_active: false,
    });
    await markProcessed(supabase, alertId);
    return {
      status: "decision_made",
      symbol: alert.symbol,
      decision: "NO_TRADE",
      gate_a: { passed: gateA.passed, quality: gateA.quality, reject_reason: gateA.rejectReason },
      gate_b: { passed: false, reason: `Invalid levels: ${levels.invalid_reason}` },
    };
  }

  // ── 6. Gate B ─────────────────────────────────────────
  const gateB = runGateB({
    alertType: alert.type,
    trend4h: trend4h.trend,
    btcRegime: regime.btc_regime,
    atr1h: atr14_1h,
    markPrice,
    rrTp1: levels.rr_tp1,
    rsi: alert.rsi,
    adx1h: alert.adx1h,
    volume: alert.volume,
    sma20Volume: alert.sma20_volume,
  });

  // ── 7. Cooldown check ─────────────────────────────────
  const cooldownActive = await isCooldownActive(alert.symbol, alert.type);

  // ── 8. Deterministic decision ─────────────────────────
  let decision: string;
  let finalGateBReason = gateB.reason;

  if (cooldownActive) {
    decision = "NO_TRADE";
    finalGateBReason = "Cooldown active (8h)";
  } else if (!gateB.passed) {
    decision = "NO_TRADE";
  } else {
    decision = direction.toUpperCase();
  }

  console.log(
    `[pipeline] ${alert.symbol} deterministic=${decision} gate_b=${gateB.passed}` +
      ` regime=${regime.btc_regime} trend_4h=${trend4h.trend}` +
      (finalGateBReason ? ` reason=${finalGateBReason}` : "")
  );

  // ── 9. Claude review (only if deterministic passed) ───
  let claudeDecision: string | null = null;
  let claudeConfidence: number | null = null;
  let setupType: string | null = null;
  let riskFlags: string[] = [];
  let reasoning: string | null = null;

  if (decision === "LONG" || decision === "SHORT") {
    // Prompt version lookup disabled — migration 004 not applied
    // const { data: promptRow } = await supabase
    //   .from("prompt_versions").select("id")
    //   .eq("is_production", true).limit(1).maybeSingle();

    const reviewInput: ClaudeReviewInput = {
      symbol: alert.symbol,
      direction,
      alert_tf: alert.tf,
      alert_price: alert.price,
      alert_rsi: alert.rsi,
      alert_adx1h: alert.adx1h,
      alert_adx4h: alert.adx4h,
      alert_bb_width: alert.bb_width,
      mark_price: markPrice,
      funding_rate: fundingRate,
      turnover_24h: turnover24h,
      spread_bps: spreadBps,
      open_interest_value: parseFloat(ticker.openInterestValue),
      book_depth_bid_usd: bookDepthBidUsd,
      book_depth_ask_usd: bookDepthAskUsd,
      oi_delta_5m: oiDelta5m,
      oi_delta_15m: oiDelta15m,
      oi_delta_1h: oiDelta1h,
      trend_4h: trend4h.trend,
      trend_1d: trend1d.trend,
      ema20_4h: trend4h.ema20,
      ema50_4h: trend4h.ema50,
      atr14_1h,
      atr14_4h,
      btc_regime: regime.btc_regime,
      alt_environment: regime.alt_environment,
      entry: levels.entry,
      stop: levels.stop,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      rr_tp1: levels.rr_tp1,
      snapshot_quality: gateA.quality,
      gate_a_quality: gateA.quality,
      gate_b_passed: gateB.passed,
    };

    try {
      const review = await reviewWithClaude(reviewInput);
      claudeDecision = review.response.decision;
      claudeConfidence = review.response.confidence;
      setupType = review.response.setup_type;
      riskFlags = review.response.risk_flags;
      reasoning = review.response.reasoning;

      console.log(
        `[pipeline] Claude: decision=${claudeDecision} confidence=${claudeConfidence} setup=${setupType}`
      );

      // Tier-aware reviewer policy:
      // STRICT_PROD: reviewer can veto (blocking)
      // RELAXED_PROD: reviewer is annotation-only (non-blocking for subjective reasoning)
      if (claudeDecision === "NO_TRADE" || claudeDecision === "INVALID") {
        if (isRelaxed) {
          // Non-blocking: keep original LONG/SHORT decision, attach reasoning as annotation
          console.log(`[pipeline] ${alert.symbol} RELAXED reviewer annotation (non-blocking): ${claudeDecision} — ${reasoning}`);
          // decision stays as LONG/SHORT
        } else {
          decision = "NO_TRADE";
        }
      }
    } catch (err) {
      if (isRelaxed) {
        // RELAXED: reviewer failure is non-blocking
        console.log(`[pipeline] ${alert.symbol} RELAXED reviewer unavailable (non-blocking):`, err);
        reasoning = "Claude review unavailable (non-blocking for RELAXED)";
      } else {
        // STRICT: reviewer failure blocks the trade
        console.error("[pipeline] Claude review failed — blocking trade:", err);
        decision = "NO_TRADE";
        reasoning = "Claude review unavailable";
      }
    }
  }

  // Set cooldown only if final decision is a trade
  if (decision === "LONG" || decision === "SHORT") {
    await setCooldown(alert.symbol, alert.type);
  }

  // ── 10. Store decision ────────────────────────────────
  // NOTE: claude columns (prompt_version_id, claude_request, claude_response,
  // claude_decision, claude_confidence) are omitted because migration 004
  // has not been applied to the live database. Including non-existent columns
  // causes the entire insert to fail silently.
  const decisionId = await storeDecision(supabase, {
    snapshot_id: snapshotId,
    alert_id: alertId,
    symbol: alert.symbol,
    alert_type: alert.type,
    alert_tf: alert.tf,
    decision,
    gate_a_passed: true,
    gate_a_quality: gateA.quality,
    gate_b_passed: gateB.passed,
    gate_b_reason: finalGateBReason,
    trend_4h: trend4h.trend,
    trend_1d: trend1d.trend,
    ema20_4h: trend4h.ema20,
    ema50_4h: trend4h.ema50,
    ema20_1d: trend1d.ema20,
    ema50_1d: trend1d.ema50,
    atr14_1h,
    atr14_4h,
    btc_regime: regime.btc_regime,
    alt_environment: regime.alt_environment,
    btc_atr_ratio: regime.btc_atr_ratio,
    entry_price: levels.entry,
    stop_price: levels.stop,
    tp1_price: levels.tp1,
    tp2_price: levels.tp2,
    tp3_price: levels.tp3,
    risk_amount: levels.risk,
    rr_tp1: levels.rr_tp1,
    rr_tp2: levels.rr_tp2,
    rr_tp3: levels.rr_tp3,
    cooldown_active: cooldownActive,
  });

  console.log(`[pipeline] Decision stored: ${decisionId} ${alert.symbol} ${decision}`);

  // ── 11. Mark alert processed ──────────────────────────
  await markProcessed(supabase, alertId);

  // ── 12. Telegram delivery ─────────────────────────────
  let telegramSent = false;
  let telegramAttempted = false;
  let telegramError: string | null = null;
  let blockedReason: string | null = null;
  let telegramBlockReason: string | null = null;

  const isTrade = decision === "LONG" || decision === "SHORT";

  if (isTrade) {
    // RELAXED_PROD Telegram quality filter
    let sendTelegram_ = true;
    if (isRelaxed) {
      const volRatio = (alert.sma20_volume && alert.sma20_volume > 0)
        ? (alert.volume ?? 0) / alert.sma20_volume : 0;
      const checks: { name: string; pass: boolean }[] = [
        { name: "pass_count", pass: true }, // pass_count not available in pipeline; checked at scanner level
        { name: "bb_width>=0.06", pass: alert.bb_width >= 0.06 },
        { name: "vol_ratio>=1.2", pass: volRatio >= 1.2 },
        { name: "rr_tp1>=1.2", pass: levels.rr_tp1 >= 1.2 },
        { name: "tp1_positive", pass: direction === "long" ? levels.tp1 > levels.entry : levels.tp1 < levels.entry },
        { name: "entry_mark_dev<=1%", pass: markPrice > 0 && Math.abs(levels.entry - markPrice) / markPrice <= 0.01 },
      ];
      const failed = checks.filter(c => !c.pass);
      if (failed.length > 0) {
        sendTelegram_ = false;
        telegramBlockReason = `RELAXED filtered: ${failed.map(f => f.name).join(", ")}`;
        console.log(`[pipeline] ${alert.symbol} RELAXED Telegram blocked: ${telegramBlockReason}`);
      }
    }

    // Repeat suppression: prevent same symbol+direction from flooding Telegram
    if (sendTelegram_) {
      const redis = getRedis();
      // Setup family = base type without tier suffix (SQ_SHORT_RELAXED → SQ_SHORT)
      const setupFamily = alert.type.replace(/_RELAXED$|_DATA$/i, "");
      const suppressKey = `tg_sent:${alert.symbol}:${setupFamily}:${direction}`;
      const alreadySent = await redis.get(suppressKey);
      if (alreadySent) {
        sendTelegram_ = false;
        const suppressWindow = isRelaxed ? "12h" : "4h";
        telegramBlockReason = `repeat_signal_within_${suppressWindow}`;
        console.log(`[pipeline] ${alert.symbol} Telegram suppressed: ${telegramBlockReason}`);
      }
    }

    if (sendTelegram_) {
      telegramAttempted = true;
      try {
        const msg = buildMessage({
          symbol: alert.symbol,
          decision,
          entry: levels.entry,
          stop: levels.stop,
          tp1: levels.tp1,
          tp2: levels.tp2,
          tp3: levels.tp3,
          confidence: claudeConfidence ?? 0,
          setup_type: setupType ?? "unknown",
          btc_regime: regime.btc_regime,
          alt_environment: regime.alt_environment,
          funding_rate: fundingRate,
          risk_flags: riskFlags,
          reasoning: reasoning ?? "",
        });
        telegramSent = await sendTelegram(msg);
        if (telegramSent) {
          // Set repeat suppression key after successful send
          const redis = getRedis();
          const setupFamily = alert.type.replace(/_RELAXED$|_DATA$/i, "");
          const suppressKey = `tg_sent:${alert.symbol}:${setupFamily}:${direction}`;
          const suppressTtl = isRelaxed ? 12 * 60 * 60 : 4 * 60 * 60;
          await redis.set(suppressKey, Date.now(), { ex: suppressTtl });
        } else {
          telegramError = "sendTelegram returned false";
        }
      } catch (err) {
        telegramError = String(err).slice(0, 200);
        console.error("[pipeline] Telegram send error:", err);
      }
    }
  } else {
    blockedReason = decision === "NO_TRADE"
      ? (reasoning ?? finalGateBReason ?? "filtered")
      : `decision=${decision}`;
  }

  // ── 12b. Update delivery tracking on stored decision ───
  if (decisionId) {
    await supabase.from("decisions").update({
      telegram_attempted: telegramAttempted,
      telegram_sent: telegramSent,
      telegram_error: telegramError ?? telegramBlockReason,
      blocked_reason: blockedReason,
    }).eq("id", decisionId);
  }

  return {
    status: "decision_made",
    symbol: alert.symbol,
    decision,
    gate_a: { passed: true, quality: gateA.quality, reject_reason: null },
    gate_b: { passed: gateB.passed, reason: finalGateBReason },
    regime: {
      btc_regime: regime.btc_regime,
      alt_environment: regime.alt_environment,
      btc_4h_trend: regime.btc_4h_trend,
      btc_1d_trend: regime.btc_1d_trend,
      btc_atr_ratio: regime.btc_atr_ratio,
    },
    htf_trend: {
      trend_4h: trend4h.trend,
      trend_1d: trend1d.trend,
      atr14_1h,
      atr14_4h,
    },
    levels: {
      entry: levels.entry,
      stop: levels.stop,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      rr_tp1: levels.rr_tp1,
    },
    claude: {
      decision: claudeDecision,
      confidence: claudeConfidence,
      setup_type: setupType,
      risk_flags: riskFlags,
      reasoning,
    },
    cooldown_active: cooldownActive,
    telegram_sent: telegramSent,
    telegram_block_reason: telegramBlockReason,
  };
}

// ── Helpers ───────────────────────────────────────────────

async function storeDecision(
  supabase: ReturnType<typeof getSupabase>,
  data: Record<string, unknown>
): Promise<string | null> {
  const { data: row, error } = await supabase.from("decisions").insert(data).select("id").maybeSingle();
  if (error) {
    console.error("[pipeline] Failed to insert decision:", error);
    return null;
  }
  return row?.id ?? null;
}

async function markProcessed(
  supabase: ReturnType<typeof getSupabase>,
  alertId: string | null
) {
  if (!alertId) return;
  const { error } = await supabase
    .from("alerts_raw")
    .update({ processed: true })
    .eq("id", alertId);
  if (error) {
    console.error("[pipeline] Failed to mark alert processed:", error);
  }
}
