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
import { getShortBtcRangePosition, runGateB } from "@/lib/gate-b";
import { calculateLevels } from "@/lib/levels";
import { isCooldownActive, setCooldown } from "@/lib/cooldown";
import { reviewSignalWithSonnet, type AIReviewResult } from "@/lib/ai-signal-reviewer";
import { gatherMarketContext } from "@/lib/market-data-gatherer";
import { buildMessage, sendTelegram } from "@/lib/telegram";
import { sendToExecutionEngine, type ExecSignalPayload } from "@/lib/exec-webhook";
import { computeCompositeScore } from "@/lib/scoring";
import { assignCluster, finalizeClusterSelection, deriveTier } from "@/lib/cluster";
import { runPreTradeRiskChecks, RiskCheckResult } from "@/lib/risk-manager";
import { getSignalContext } from "@/lib/signal-context";
import { warnSignalRuntimeConfigOnce } from "@/lib/runtime-checks";
import { getTelegramFilterBlockReason } from "@/lib/telegram-filters";

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
  decision_id?: string | null;
  cluster_id?: string | null;
  selected_for_execution?: boolean;
  suppressed_reason?: string | null;
  auto_exec_eligible?: boolean;
  execution_payload?: ExecSignalPayload | null;
  gate_a: { passed: boolean; quality: string; reject_reason: string | null };
  gate_b?: { passed: boolean; reason: string | null };
  regime?: {
    btc_regime: string;
    alt_environment: string;
    btc_4h_trend: string;
    btc_1d_trend: string;
    btc_atr_ratio: number;
    transition_zone: boolean;
    regime_weakening: boolean;
    regime_age_hours: number | null;
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
    tp0?: number;
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
  ai_review?: AIReviewResult | null;
  cooldown_active?: boolean;
  telegram_sent?: boolean;
  telegram_block_reason?: string | null;
  error?: string;
  http_status?: number;
}

interface PipelineOptions {
  deferClusterExecution?: boolean;
}

export async function runPipeline(
  alert: AlertPayload,
  alertId: string | null,
  options?: PipelineOptions
): Promise<PipelineResult> {
  warnSignalRuntimeConfigOnce();
  const supabase = getSupabase();
  const deferClusterExecution = options?.deferClusterExecution === true;

  const rawType = alert.type.toLowerCase();
  let direction: "long" | "short" = rawType.includes("short") ? "short" : "long";
  const tier = deriveTier(alert.type);
  const isRelaxed = tier === "RELAXED";
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

  // ── 4a. Transition zone risk halving (effectiveRisk computed after levels) ──
  if (regime.transition_zone) {
    console.warn(`[pipeline] ${alert.symbol} TRANSITION_ZONE: BTC near EMA200, halving risk`);
  }

  // ── 4b. BTC 4h price change (data collection) ─────────
  let btc4hChange: number | null = null;
  try {
    const btcRes = await fetch(
      "https://api.bybit.com/v5/market/kline?symbol=BTCUSDT&interval=240&limit=2&category=linear",
      { cache: "no-store" }
    );
    const btcData = await btcRes.json();
    const btcCandles = btcData?.result?.list;
    if (btcCandles && btcCandles.length >= 2) {
      const currentClose = parseFloat(btcCandles[0][4]);
      const prevClose = parseFloat(btcCandles[1][4]);
      if (prevClose > 0) {
        btc4hChange = ((currentClose - prevClose) / prevClose) * 100;
        console.log(`[pipeline] BTC 4h change: ${btc4hChange.toFixed(2)}%`);
      }
    }
  } catch (err) {
    console.warn("[pipeline] Failed to fetch BTC 4h change:", err);
  }

  // ── 4c. BTC 12h range position (computed early so all stored decisions have it) ──
  let btcRangePct12h: number | null = null;
  btcRangePct12h = await getShortBtcRangePosition(
    alert.symbol,
    alert.type,
    new Date()
  );

  // ── 5. Price levels ───────────────────────────────────
  const levels = calculateLevels(markPrice, atr14_1h, direction);
  const effectiveRisk = regime.transition_zone ? levels.risk * 0.5 : levels.risk;

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
      btc_range_pct_12h: btcRangePct12h,
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

  // ── 5c. Stop distance filter ────────────────────────────
  const maxStopDistPct = parseFloat(process.env.MAX_STOP_DIST_PCT ?? "0.05");
  const stopDistPct = Math.abs(levels.stop - levels.entry) / levels.entry;
  if (stopDistPct > maxStopDistPct) {
    const pctDisplay = (stopDistPct * 100).toFixed(1);
    console.log(`[pipeline] ${alert.symbol} REJECTED: stop_too_wide: ${pctDisplay}%`);
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
      gate_b_reason: `stop_too_wide: ${pctDisplay}%`,
      trend_4h: trend4h.trend,
      trend_1d: trend1d.trend,
      btc_regime: regime.btc_regime,
      alt_environment: regime.alt_environment,
      btc_range_pct_12h: btcRangePct12h,
      cooldown_active: false,
    });
    await markProcessed(supabase, alertId);
    return {
      status: "decision_made",
      symbol: alert.symbol,
      decision: "NO_TRADE",
      gate_a: { passed: gateA.passed, quality: gateA.quality, reject_reason: gateA.rejectReason },
      gate_b: { passed: false, reason: `stop_too_wide: ${pctDisplay}%` },
    };
  }

  // ── 5d. Sideways SQ_SHORT → SQ_LONG_REVERSAL ─────────
  let reversal = false;
  let originalAlertType: string | null = null;
  let originalDirection: "long" | "short" | null = null;

  if (
    regime.btc_regime === "sideways" &&
    alert.type.toLowerCase().includes("sq_short") &&
    !alert.type.toLowerCase().includes("data")
  ) {
    originalAlertType = alert.type;
    originalDirection = direction;

    // Flip direction
    direction = "long";                          // was "short"
    alert.type = "SQ_LONG_REVERSAL";
    reversal = true;

    // Reversed geometry: reuse the original short risk distance with the canonical 3-target ladder.
    const R = levels.stop - levels.entry;        // positive: short stop is above entry
    levels.stop = levels.entry - R;              // new stop below entry
    levels.tp0 = undefined;
    levels.tp1 = levels.entry + R * 0.5;
    levels.tp2 = levels.entry + R * 1.0;
    levels.tp3 = levels.entry + R * 2.5;
    levels.risk = R;
    levels.rr_tp1 = 0.5;
    levels.rr_tp2 = 1.0;
    levels.rr_tp3 = 2.5;

    console.log(`[pipeline] ${alert.symbol}: sideways regime → reversed to SQ_LONG_REVERSAL`);
  }

  // ── 5b. Compute scoring inputs + composite score ──────
  // Moved BEFORE gate B so the sideways-MR_LONG soft gate can use the
  // composite score. computeCompositeScore is a pure function with no
  // side effects, so reordering is safe.
  const volRatio =
    alert.sma20_volume && alert.sma20_volume > 0
      ? (alert.volume ?? 0) / alert.sma20_volume
      : null;
  const entryDeviationPct =
    markPrice > 0
      ? Math.abs(levels.entry - markPrice) / markPrice
      : null;

  const scoreResult = computeCompositeScore({
    atr14_1h: atr14_1h,
    mark_price: markPrice,
    vol_ratio: volRatio,
    alert_type: alert.type,
  });

  // ── 6. Gate B ─────────────────────────────────────────
  const gateB = runGateB({
    symbol: alert.symbol,
    alertType: alert.type,
    trend4h: trend4h.trend,
    btcRegime: regime.btc_regime,
    atr1h: atr14_1h,
    markPrice,
    rrTp1: levels.rr_tp1,
    rrTp2: levels.rr_tp2,
    rsi: alert.rsi,
    adx1h: alert.adx1h,
    volume: alert.volume,
    sma20Volume: alert.sma20_volume,
    btcRangePct12h,
    signalTime: new Date(),
    compositeScore: scoreResult.composite_score,
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

  // ── 8c. Pre-review score/volume gate ──────────────────
  const volRatioMinimum = parseFloat(process.env.VOL_RATIO_MIN ?? "0.5");
  const preReviewBlocked =
    (volRatio !== null && volRatio < volRatioMinimum) ||
    scoreResult.composite_score < 20;

  let reasoning: string | null = null;

  if (preReviewBlocked) {
    reasoning = "skipped: deterministic filter";
    console.log(
      `[pipeline] ${alert.symbol} skipping Claude review: vol_ratio=${volRatio?.toFixed(2) ?? "null"} composite=${scoreResult.composite_score.toFixed(1)}`
    );
  }

  // ── 9. AI Signal Review (Sonnet — observation mode) ────
  // Replaces Haiku reviewer. Every gate-b-passed signal gets Sonnet analysis.
  // AI does NOT gate signals — it informs via Telegram. All signals still flow.
  const signalCtx = await getSignalContext(alert.symbol);

  let claudeDecision: string | null = null;
  let claudeConfidence: number | null = null;
  let setupType: string | null = null;
  let riskFlags: string[] = [];
  let aiReview: AIReviewResult | null = null;

  if (decision === "SHORT" && !preReviewBlocked) {
    try {
      // Gather comprehensive market context for Sonnet
      const marketContext = await gatherMarketContext(
        alert.symbol,
        {
          entry: levels.entry,
          stop: levels.stop,
          tp1: levels.tp1,
          tp2: levels.tp2,
          tp3: levels.tp3,
          alert_type: alert.type,
          bb_width: alert.bb_width,
          atr14_1h,
        },
        signalCtx
      );

      // Call Sonnet for structural analysis
      aiReview = await reviewSignalWithSonnet(marketContext);

      if (aiReview) {
        // Map Sonnet output to existing pipeline fields for backward compatibility
        claudeConfidence = Math.round(aiReview.confidence / 10); // 0-100 → 1-10 scale
        setupType = aiReview.pattern;
        riskFlags = aiReview.concerns;
        reasoning = aiReview.reasoning;

        // Map verdict to a decision label (for backward compat with dashboard/grading)
        // NOTE: this does NOT gate the signal — decision stays LONG/SHORT regardless
        claudeDecision = aiReview.overall_verdict === "avoid" ? "NO_TRADE" : decision;

        console.log(
          `[pipeline] Sonnet AI: confidence=${aiReview.confidence}/100 pattern=${aiReview.pattern} verdict=${aiReview.overall_verdict}`
        );
      } else {
        console.warn(`[pipeline] ${alert.symbol} Sonnet review returned null — pipeline continues`);
        reasoning = "AI review unavailable";
      }

      // NO GATING: signal proceeds regardless of AI verdict.
      // The AI's job is to inform, not filter.
    } catch (err) {
      console.warn("[pipeline] AI signal review failed — proceeding without review:", err);
      reasoning = "AI review unavailable (error)";
    }
  }

  // Set cooldown only if final decision is a trade
  if (decision === "LONG" || decision === "SHORT") {
    await setCooldown(alert.symbol, alert.type);
  }


  // Deterministic fallback when Claude API is unavailable — avoids "0/10, unknown" in Telegram
  if (!claudeConfidence && scoreResult) {
    claudeConfidence = scoreResult.composite_score > 70 ? 7 : scoreResult.composite_score > 50 ? 5 : 3;
    setupType = alert.type.includes("SQ_") ? "squeeze_breakout" : "mean_reversion";
  }

  // ── 9c. Cluster assignment + execution selection ──────
  const isTradeBefore = decision === "LONG" || decision === "SHORT";
  let clusterData: {
    cluster_id: string | null;
    cluster_hour: string | null;
    cluster_size: number;
    cluster_rank: number | null;
    selected_for_execution: boolean;
    suppressed_reason: string | null;
  } = {
    cluster_id: null,
    cluster_hour: null,
    cluster_size: 1,
    cluster_rank: null,
    selected_for_execution: false,
    suppressed_reason: null,
  };

  if (isTradeBefore) {
    try {
      const cluster = await assignCluster({
        symbol: alert.symbol,
        decision,
        alert_type: alert.type,
        btc_regime: regime.btc_regime,
        created_at: new Date(),
        composite_score: scoreResult.composite_score,
        rr_tp1: levels.rr_tp1,
        cooldown_active: cooldownActive,
      });
      clusterData = cluster;
    } catch (err) {
      console.error("[pipeline] Cluster assignment failed (non-blocking):", err);
    }
  }

  // ── 9d. Portfolio risk checks ──────────────────────────
  let riskCheckResult: RiskCheckResult | null = null;
  if (isTradeBefore) {
    try {
      riskCheckResult = await runPreTradeRiskChecks(effectiveRisk);
      if (!riskCheckResult.approved) {
        console.log(`[pipeline] ${alert.symbol} risk check rejected: ${riskCheckResult.reason}`);
        decision = "NO_TRADE";
        finalGateBReason = riskCheckResult.reason ?? "RISK_CHECK_FAILED";
      }
    } catch (err) {
      console.warn("[pipeline] Risk check error (non-blocking, fail open):", err);
    }
  }

  // ── 10. Store decision ────────────────────────────────
  // Base fields always exist. Extended fields (migration 014) are attempted
  // first; if insert fails due to missing columns, retry with base only.
  const baseData: Record<string, unknown> = {
    snapshot_id: snapshotId,
    alert_id: alertId,
    symbol: alert.symbol,
    alert_type: alert.type,
    original_alert_type: originalAlertType,
    original_direction: originalDirection,
    alert_tf: alert.tf,
    decision,
    gate_a_passed: gateA.passed,
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
    btc_4h_change: btc4hChange,
    entry_price: levels.entry,
    stop_price: levels.stop,
    tp1_price: levels.tp1,
    tp2_price: levels.tp2,
    tp3_price: levels.tp3,
    risk_amount: effectiveRisk,
    rr_tp1: levels.rr_tp1,
    rr_tp2: levels.rr_tp2,
    rr_tp3: levels.rr_tp3,
    cooldown_active: cooldownActive,
    risk_check_result: riskCheckResult ? { approved: riskCheckResult.approved, reason: riskCheckResult.reason, composite_score: scoreResult.composite_score } : null,
  };

  // ── Burst context (data collection only) ──────────────
  let hours_since_last_burst: number | null = null;
  let last_burst_size: number | null = null;

  const { data: lastBurst } = await supabase
    .from("decisions")
    .select("created_at")
    .eq("telegram_sent", true)
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false });

  if (lastBurst && lastBurst.length > 0) {
    const hourCounts = new Map<string, number>();
    for (const row of lastBurst) {
      const hour = (row.created_at as string).slice(0, 13); // YYYY-MM-DDTHH
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    }

    const currentHour = new Date().toISOString().slice(0, 13);
    let lastBurstHour: string | null = null;
    let lastBurstSize = 0;

    const sortedHours = (Array.from(hourCounts.entries()) as [string, number][]).sort((a, b) => b[0].localeCompare(a[0]));
    for (const [hour, count] of sortedHours) {
      if (count >= 5 && hour !== currentHour) {
        lastBurstHour = hour;
        lastBurstSize = count;
        break;
      }
    }

    if (lastBurstHour) {
      const burstTime = new Date(lastBurstHour + ":00:00Z");
      const hoursSince = (Date.now() - burstTime.getTime()) / (1000 * 60 * 60);
      hours_since_last_burst = Math.round(hoursSince * 10) / 10;
      last_burst_size = lastBurstSize;
    }
  }

  // ── Signal context enrichment (already fetched before reviewer) ──

  // LONG signals are alert-only — never auto-execute (manual entry at better levels)
  const isLongDirection = direction.toUpperCase() === 'LONG' || alert.type.toUpperCase().includes('LONG_REVERSAL');
  if (isLongDirection && clusterData.selected_for_execution) {
    clusterData.selected_for_execution = false;
    console.log(`[pipeline] ${alert.symbol} LONG signal — forcing selected_for_execution=false`);
  }

  const extendedData: Record<string, unknown> = {
    ...baseData,
    tp0_price: levels.tp0 ?? null,
    vol_ratio: volRatio,
    btc_range_pct_12h: btcRangePct12h,
    entry_deviation_pct: entryDeviationPct,
    composite_score: scoreResult.composite_score,
    cluster_id: clusterData.cluster_id,
    cluster_hour: clusterData.cluster_hour,
    cluster_size: clusterData.cluster_size,
    cluster_rank: clusterData.cluster_rank,
    selected_for_execution: clusterData.selected_for_execution,
    suppressed_reason: clusterData.suppressed_reason,
    claude_confidence: claudeConfidence,
    transition_zone: regime.transition_zone,
    regime_weakening: regime.regime_weakening,
    regime_age_hours: regime.regime_age_hours,
    hours_since_last_burst,
    last_burst_size,
    signal_funding_rate: signalCtx.funding_rate,
    signal_funding_interval: signalCtx.funding_interval,
    signal_oi_delta_1h_pct: signalCtx.oi_delta_1h_pct,
    signal_oi_delta_4h_pct: signalCtx.oi_delta_4h_pct,
    signal_spread_pct: signalCtx.spread_pct,
    signal_btc_correlation: signalCtx.btc_correlation,
    signal_btc_beta: signalCtx.btc_beta,
    ai_review: aiReview,
  };

  const decisionId = await storeDecision(supabase, extendedData, baseData);

  // ── SAFETY GUARD: decision must be persisted before any downstream action ──
  if (!decisionId) {
    console.error(`[pipeline] CRITICAL: Decision insert failed for ${alert.symbol} ${decision} — aborting Telegram and downstream`);
    return {
      status: "error",
      symbol: alert.symbol,
      decision,
      gate_a: { passed: true, quality: gateA.quality, reject_reason: null },
      error: "Decision insert failed — Telegram blocked",
      http_status: 500,
    };
  }

  console.log(`[pipeline] Decision stored: ${decisionId} ${alert.symbol} ${decision}`);

  // ── 10b. Try to finalize cluster if window already expired ──
  // This handles the case where a signal arrives after the 60s window.
  // For signals within the window, finalization is triggered by dashboard reads.
  if (!deferClusterExecution && clusterData.cluster_id && !clusterData.selected_for_execution && !clusterData.suppressed_reason) {
    try {

      await finalizeClusterSelection(clusterData.cluster_id);

    } catch (err) {

      console.error('[pipeline] finalizeClusterSelection error:', err);

    }
  }

  // ── 11. Mark alert processed ──────────────────────────
  await markProcessed(supabase, alertId);

  // ── 12. Telegram delivery ─────────────────────────────
  let telegramSent = false;
  let telegramAttempted = false;
  let telegramError: string | null = null;
  let blockedReason: string | null = null;
  let telegramBlockReason: string | null = null;

  const isTrade = decision === "LONG" || decision === "SHORT";
  const autoExecEligible = isTrade && !isLongDirection;
  const executionPayload: ExecSignalPayload | null = autoExecEligible
    ? {
        symbol: alert.symbol,
        direction: direction.toUpperCase() as 'LONG' | 'SHORT',
        entry_price: levels.entry,
        stop_price: levels.stop,
        tp0_price: levels.tp0 ?? null,
        tp1_price: levels.tp1,
        tp2_price: levels.tp2,
        tp3_price: levels.tp3,
        risk_amount: effectiveRisk,
        btc_regime: regime.btc_regime,
        composite_score: scoreResult.composite_score,
        alert_type: alert.type,
        confidence: claudeConfidence ?? 0,
        decision_id: decisionId ?? '',
        timestamp: new Date().toISOString(),
      }
    : null;

  if (isTrade) {
    let sendTelegram_ = true;
    const telegramVolRatio = (alert.sma20_volume && alert.sma20_volume > 0)
      ? (alert.volume ?? 0) / alert.sma20_volume : 0;
    const bearBbMax = parseFloat(process.env.BEAR_BB_WIDTH_MAX ?? "0.12");
    const bearVolDeadLow = parseFloat(process.env.BEAR_VOL_DEAD_ZONE_LOW ?? "2.0");
    const bearVolDeadHigh = parseFloat(process.env.BEAR_VOL_DEAD_ZONE_HIGH ?? "2.5");

    if (sendTelegram_) {
      telegramBlockReason = getTelegramFilterBlockReason({
        regime: regime.btc_regime,
        isRelaxed,
        regimeWeakening: regime.regime_weakening,
        bbWidth: alert.bb_width,
        telegramVolRatio,
        volRatio,
        compositeScore: scoreResult.composite_score,
        rrTp2: levels.rr_tp2,
        direction,
        tp1: levels.tp1,
        entry: levels.entry,
        markPrice,
        claudeConfidence,
        bearBbMax,
        bearVolDeadLow,
        bearVolDeadHigh,
      });
      if (telegramBlockReason) {
        sendTelegram_ = false;
        console.log(
          `[pipeline] ${alert.symbol} Telegram blocked: ${telegramBlockReason} (bb_width=${alert.bb_width?.toFixed(
            3
          )}, vol_ratio=${telegramVolRatio.toFixed(2)}, score=${scoreResult.composite_score.toFixed(1)})`
        );
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
          setup_type: reversal ? "SQ_LONG_REVERSAL" : (setupType ?? "unknown"),
          btc_regime: regime.btc_regime,
          alt_environment: regime.alt_environment,
          funding_rate: fundingRate,
          risk_flags: reversal ? [...riskFlags, "REVERSAL"] : riskFlags,
          reasoning: reversal
            ? `REVERSAL: SQ_SHORT flipped to LONG in sideways regime (59% WR, +0.16R). ${reasoning ?? ""}`
            : (reasoning ?? ""),
          ai_review: aiReview ?? undefined,
        });
        telegramSent = await sendTelegram(msg);
        if (telegramSent) {
          if (clusterData.selected_for_execution && executionPayload) {
            // Send to execution engine (AWAITED — Vercel serverless kills pending fetches when handler returns)
            if (deferClusterExecution) {
              console.log(`[pipeline] ${alert.symbol} webhook deferred: scanner-managed cluster finalization`);
            } else {
              try {
                await sendToExecutionEngine(executionPayload);
              } catch (err) {
                console.error('[pipeline] Exec webhook error (awaited):', err);
              }
            }
          } else {
            console.log(`[pipeline] ${alert.symbol} webhook skipped: selected_for_execution=false`);
          }

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
      blocked_reason: blockedReason ?? telegramBlockReason,
    }).eq("id", decisionId);
  }

  return {
    status: "decision_made",
    symbol: alert.symbol,
    decision,
    decision_id: decisionId,
    cluster_id: clusterData.cluster_id,
    selected_for_execution: clusterData.selected_for_execution,
    suppressed_reason: clusterData.suppressed_reason,
    auto_exec_eligible: autoExecEligible,
    execution_payload: executionPayload,
    gate_a: { passed: true, quality: gateA.quality, reject_reason: null },
    gate_b: { passed: gateB.passed, reason: finalGateBReason },
    regime: {
      btc_regime: regime.btc_regime,
      alt_environment: regime.alt_environment,
      btc_4h_trend: regime.btc_4h_trend,
      btc_1d_trend: regime.btc_1d_trend,
      btc_atr_ratio: regime.btc_atr_ratio,
      transition_zone: regime.transition_zone,
      regime_weakening: regime.regime_weakening,
      regime_age_hours: regime.regime_age_hours,
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
      tp0: levels.tp0,
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
    ai_review: aiReview,
  };
}

// ── Helpers ───────────────────────────────────────────────

async function storeDecision(
  supabase: ReturnType<typeof getSupabase>,
  data: Record<string, unknown>,
  fallbackData?: Record<string, unknown>
): Promise<string | null> {
  const { data: row, error } = await supabase.from("decisions").insert(data).select("id").maybeSingle();
  if (error) {
    // If insert fails due to missing columns (migration not applied), retry with base data
    if (fallbackData && error.message.includes("does not exist")) {
      console.warn("[pipeline] Extended columns not available, retrying with base schema");
      const { data: fallbackRow, error: fbErr } = await supabase
        .from("decisions")
        .insert(fallbackData)
        .select("id")
        .maybeSingle();
      if (fbErr) {
        console.error("[pipeline] Failed to insert decision (fallback):", fbErr);
        return null;
      }
      return fallbackRow?.id ?? null;
    }
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
