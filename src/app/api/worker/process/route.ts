import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getRedis, ALERTS_QUEUE_KEY } from "@/lib/redis";
import {
  fetchTicker,
  fetchOrderbook,
  fetchOIHistory,
  computeSpreadBps,
  computeBookDepthUsd,
  computeOIDelta,
} from "@/lib/bybit";

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

  // Quality tiers
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

  // 1. Pop one alert from queue (FIFO)
  const raw = await redis.rpop<string>(ALERTS_QUEUE_KEY);

  if (!raw) {
    return NextResponse.json(
      { status: "empty", message: "No alerts in queue" },
      { status: 200 }
    );
  }

  let alert: AlertPayload;
  try {
    alert = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    console.error("Failed to parse alert from queue:", raw);
    return NextResponse.json({ error: "Corrupt queue entry" }, { status: 500 });
  }

  console.log(`[worker] Enriching alert: symbol=${alert.symbol} type=${alert.type}`);

  // 2. Find the alert_id from alerts_raw
  const { data: rawRow } = await supabase
    .from("alerts_raw")
    .select("id")
    .eq("processed", false)
    .contains("payload", { symbol: alert.symbol, type: alert.type })
    .order("received_at", { ascending: true })
    .limit(1)
    .single();

  const alertId: string | null = rawRow?.id ?? null;

  // 3. Fetch all market data in parallel
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
    console.error(`[worker] Bybit API error for ${alert.symbol}:`, err);
    return NextResponse.json(
      { error: "Market data fetch failed", symbol: alert.symbol },
      { status: 502 }
    );
  }

  // 4. Compute derived values
  const markPrice = parseFloat(ticker.markPrice);
  const turnover24h = parseFloat(ticker.turnover24h);
  const spreadBps = computeSpreadBps(ticker.bid1Price, ticker.ask1Price);
  const bookDepthBidUsd = computeBookDepthUsd(orderbook.bids, markPrice);
  const bookDepthAskUsd = computeBookDepthUsd(orderbook.asks, markPrice);
  const oiDelta5m = computeOIDelta(oi5m);
  const oiDelta15m = computeOIDelta(oi15m);
  const oiDelta1h = computeOIDelta(oi1h);

  // 5. Gate A check
  const gateA = runGateA(markPrice, turnover24h, orderbook.ts, spreadBps);

  console.log(
    `[worker] ${alert.symbol} gate_a=${gateA.passed} quality=${gateA.quality}` +
      (gateA.rejectReason ? ` reason=${gateA.rejectReason}` : "")
  );

  // 6. Store enriched snapshot
  const { error: snapError } = await supabase
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
    });

  if (snapError) {
    console.error("[worker] Failed to insert market_snapshot:", snapError);
    return NextResponse.json(
      { error: "Snapshot insert failed" },
      { status: 500 }
    );
  }

  // 7. Mark alert as processed
  if (alertId) {
    const { error: updateError } = await supabase
      .from("alerts_raw")
      .update({ processed: true })
      .eq("id", alertId);

    if (updateError) {
      console.error("[worker] Failed to mark alert processed:", updateError);
    }
  }

  return NextResponse.json({
    status: "enriched",
    symbol: alert.symbol,
    gate_a: {
      passed: gateA.passed,
      quality: gateA.quality,
      reject_reason: gateA.rejectReason,
    },
  });
}
