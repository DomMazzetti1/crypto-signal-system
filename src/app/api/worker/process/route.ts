import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getRedis, ALERTS_QUEUE_KEY } from "@/lib/redis";
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

interface AlertPayload {
  type: string;
  symbol: string;
  tf: string;
  price: number;
  rsi: number;
  adx1h: number;
  adx4h: number;
  bb_width: number;
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

export async function POST() {
  const redis = getRedis();
  const supabase = getSupabase();

  // ── 1. Pop alert from queue ───────────────────────────
  const raw = await redis.rpop<string>(ALERTS_QUEUE_KEY);
  if (!raw) {
    return NextResponse.json({ status: "empty", message: "No alerts in queue" });
  }

  let alert: AlertPayload;
  try {
    alert = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    console.error("Failed to parse alert from queue:", raw);
    return NextResponse.json({ error: "Corrupt queue entry" }, { status: 500 });
  }

  const rawType = alert.type.toLowerCase();
  const direction: "long" | "short" = rawType === "short" ? "short" : "long";
  console.log(`[worker] Processing: ${alert.symbol} type=${alert.type} direction=${direction}`);

  // ── 2. Find alert_id ──────────────────────────────────
  const { data: rawRow } = await supabase
    .from("alerts_raw")
    .select("id")
    .eq("processed", false)
    .contains("payload", { symbol: alert.symbol, type: alert.type })
    .order("received_at", { ascending: true })
    .limit(1)
    .single();

  const alertId: string | null = rawRow?.id ?? null;

  // ── 3. Enrichment: market data (parallel) ─────────────
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
    console.error(`[worker] Bybit market data error for ${alert.symbol}:`, err);
    return NextResponse.json(
      { error: "Market data fetch failed", symbol: alert.symbol },
      { status: 502 }
    );
  }

  const markPrice = parseFloat(ticker.markPrice);
  const turnover24h = parseFloat(ticker.turnover24h);
  const spreadBps = computeSpreadBps(ticker.bid1Price, ticker.ask1Price);
  const bookDepthBidUsd = computeBookDepthUsd(orderbook.bids, markPrice);
  const bookDepthAskUsd = computeBookDepthUsd(orderbook.asks, markPrice);
  const oiDelta5m = computeOIDelta(oi5m);
  const oiDelta15m = computeOIDelta(oi15m);
  const oiDelta1h = computeOIDelta(oi1h);

  // ── 4. Gate A ─────────────────────────────────────────
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
      funding_rate: parseFloat(ticker.fundingRate),
      next_funding_time: new Date(Number(ticker.nextFundingTime)).toISOString(),
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
    console.error("[worker] Failed to insert snapshot:", snapError);
    return NextResponse.json({ error: "Snapshot insert failed" }, { status: 500 });
  }

  const snapshotId: string | null = snapRow?.id ?? null;

  // If Gate A fails, record NO_TRADE and stop
  if (!gateA.passed) {
    console.log(`[worker] ${alert.symbol} Gate A rejected: ${gateA.rejectReason}`);
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
    return NextResponse.json({
      status: "decision_made",
      symbol: alert.symbol,
      decision: "NO_TRADE",
      gate_a: { passed: false, quality: gateA.quality, reject_reason: gateA.rejectReason },
      gate_b: { passed: false, reason: `Gate A rejected: ${gateA.rejectReason}` },
    });
  }

  // ── 5. HTF Trend (parallel with regime) ───────────────
  let candles1h, candles4h, candles1d;
  try {
    [candles1h, candles4h, candles1d] = await Promise.all([
      fetchKlines(alert.symbol, "60", 20),
      fetchKlines(alert.symbol, "240", 50),
      fetchKlines(alert.symbol, "D", 14),
    ]);
  } catch (err) {
    console.error(`[worker] Kline fetch error for ${alert.symbol}:`, err);
    return NextResponse.json(
      { error: "Kline data fetch failed", symbol: alert.symbol },
      { status: 502 }
    );
  }

  const trend4h = computeHTFTrend(candles4h);
  const trend1d = computeHTFTrend(candles1d);
  const atr14_1h = latestATR(candles1h, 14);
  const atr14_4h = latestATR(candles4h, 14);

  // ── 6. Regime classification ──────────────────────────
  let regime;
  try {
    regime = await classifyRegime();
  } catch (err) {
    console.error("[worker] Regime classification error:", err);
    return NextResponse.json({ error: "Regime classification failed" }, { status: 502 });
  }

  // ── 7. Price levels ───────────────────────────────────
  const levels = calculateLevels(markPrice, atr14_1h, direction);

  // ── 8. Gate B ─────────────────────────────────────────
  const gateB = runGateB(
    alert.type,
    trend4h.trend,
    regime.alt_environment,
    atr14_1h,
    markPrice,
    levels.rr_tp1
  );

  // ── 9. Cooldown check ─────────────────────────────────
  const cooldownActive = await isCooldownActive(alert.symbol, alert.type);

  // ── 10. Final decision ────────────────────────────────
  let decision: string;
  let finalGateBReason = gateB.reason;

  if (cooldownActive) {
    decision = "NO_TRADE";
    finalGateBReason = "Cooldown active (8h)";
  } else if (!gateB.passed) {
    decision = "NO_TRADE";
  } else {
    decision = direction.toUpperCase();
    // Set cooldown for this symbol+type
    await setCooldown(alert.symbol, alert.type);
  }

  console.log(
    `[worker] ${alert.symbol} decision=${decision} gate_b=${gateB.passed}` +
      ` regime=${regime.btc_regime} trend_4h=${trend4h.trend}` +
      (finalGateBReason ? ` reason=${finalGateBReason}` : "")
  );

  // ── 11. Store decision ────────────────────────────────
  await storeDecision(supabase, {
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

  // ── 12. Mark alert processed ──────────────────────────
  await markProcessed(supabase, alertId);

  // ── 13. Return full decision packet ───────────────────
  return NextResponse.json({
    status: "decision_made",
    symbol: alert.symbol,
    gate_a: {
      passed: true,
      quality: gateA.quality,
      reject_reason: null,
    },
    gate_b: {
      passed: gateB.passed,
      reason: finalGateBReason,
    },
    regime: {
      btc_regime: regime.btc_regime,
      alt_environment: regime.alt_environment,
      btc_4h_trend: regime.btc_4h_trend,
      btc_1d_trend: regime.btc_1d_trend,
      btc_atr_ratio: regime.btc_atr_ratio,
    },
    htf_trend: {
      trend_4h: trend4h.trend,
      ema20_4h: trend4h.ema20,
      ema50_4h: trend4h.ema50,
      trend_1d: trend1d.trend,
      ema20_1d: trend1d.ema20,
      ema50_1d: trend1d.ema50,
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
    decision,
    cooldown_active: cooldownActive,
  });
}

// ── Helpers ───────────────────────────────────────────────

async function storeDecision(
  supabase: ReturnType<typeof getSupabase>,
  data: Record<string, unknown>
) {
  const { error } = await supabase.from("decisions").insert(data);
  if (error) {
    console.error("[worker] Failed to insert decision:", error);
  }
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
    console.error("[worker] Failed to mark alert processed:", error);
  }
}
