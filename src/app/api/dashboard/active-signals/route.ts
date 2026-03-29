import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { parseBybitResponse } from "@/lib/bybit";
import { computeCompositeScore } from "@/lib/scoring";
import { finalizeExpiredClusters } from "@/lib/cluster";
import { resolveSymbols, mapGeckoPrices } from "@/lib/price-symbol-map";

export const dynamic = "force-dynamic";

const BYBIT_BASE = "https://api.bybit.com/v5/market";

// Columns that exist since the original decisions schema (always safe to query)
const BASE_COLUMNS = `id, symbol, decision, alert_type, alert_tf, created_at,
       entry_price, stop_price, tp1_price, tp2_price, tp3_price,
       rr_tp1, rr_tp2,
       telegram_sent, telegram_attempted, blocked_reason,
       gate_a_quality, gate_b_passed, gate_b_reason, btc_regime,
       alert_id`;

// Columns added by migration 014 — may not exist in all environments
const EXTENDED_COLUMNS = `${BASE_COLUMNS},
       vol_ratio, entry_deviation_pct, composite_score,
       cluster_id, cluster_hour, cluster_size, cluster_rank,
       selected_for_execution, suppressed_reason,
       graded_outcome,
       tp1_hit_at, tp2_hit_at, tp3_hit_at, stopped_at, resolved_at`;

type PriceSource = "coingecko" | "relay" | "bybit" | "none";

interface PriceResult {
  prices: Map<string, number>;
  source: PriceSource;
}

async function fetchPricesFromCoinGecko(symbols: string[]): Promise<Map<string, number>> {
  const { geckoIds } = resolveSymbols(symbols);
  if (geckoIds.length === 0) throw new Error("No mappable symbols");

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${geckoIds.join(",")}&vs_currencies=usd`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data !== "object") throw new Error("CoinGecko bad response");

  const map = mapGeckoPrices(data, symbols);
  if (map.size === 0) throw new Error("CoinGecko returned no usable prices");
  return map;
}

async function fetchPricesFromRelay(baseUrl: string): Promise<Map<string, number>> {
  const res = await fetch(`${baseUrl}/prices`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Relay HTTP ${res.status}`);
  const data = await res.json();
  const pricesObj = data.prices;
  if (!pricesObj || typeof pricesObj !== "object") throw new Error("Relay response missing prices object");
  const map = new Map<string, number>();
  for (const [symbol, price] of Object.entries(pricesObj)) {
    const p = Number(price);
    if (Number.isFinite(p)) map.set(symbol, p);
  }
  if (map.size === 0) throw new Error("Relay returned empty prices");
  return map;
}

async function fetchPricesFromBybit(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const res = await fetch(`${BYBIT_BASE}/tickers?category=linear`, {
    cache: "no-store",
  });
  const data = await parseBybitResponse(res, "Batch tickers");
  if (data.retCode !== 0) return map;
  const list = data.result.list as { symbol: string; markPrice: string }[];
  for (const t of list) {
    const p = parseFloat(t.markPrice);
    if (Number.isFinite(p)) map.set(t.symbol, p);
  }
  return map;
}

async function fetchAllPrices(symbols: string[]): Promise<PriceResult> {
  // 1. Try CoinGecko (works everywhere, no geo-restrictions)
  try {
    const prices = await fetchPricesFromCoinGecko(symbols);
    return { prices, source: "coingecko" };
  } catch (err) {
    console.warn("[active-signals] CoinGecko price fetch failed:", err);
  }

  // 2. Try relay if configured
  const relayBase = process.env.PRICE_API_BASE_URL;
  if (relayBase) {
    try {
      const prices = await fetchPricesFromRelay(relayBase);
      return { prices, source: "relay" };
    } catch (err) {
      console.warn("[active-signals] Relay price fetch failed:", err);
    }
  }

  // 3. Fallback to direct Bybit
  try {
    const prices = await fetchPricesFromBybit();
    if (prices.size > 0) {
      return { prices, source: "bybit" };
    }
  } catch {
    // best-effort
  }

  // 4. All failed
  return { prices: new Map(), source: "none" };
}

/**
 * Live dashboard status — derived from current price vs levels.
 * This is NOT the graded research outcome (graded_outcome).
 *
 * Returns both:
 *   - live_status: summary (OPEN, TP1_HIT, TP2_HIT, TP3_HIT, STOPPED, UNKNOWN)
 *   - individual hit flags for granular TP tracking
 */
interface LiveStatus {
  live_status: string;
  live_tp1_hit: boolean;
  live_tp2_hit: boolean;
  live_tp3_hit: boolean;
  live_stop_hit: boolean;
}

function computeLiveStatus(
  decision: string,
  current: number | null,
  entry: number | null,
  stop: number | null,
  tp1: number | null,
  tp2: number | null,
  tp3: number | null
): LiveStatus {
  if (current == null || entry == null) {
    return { live_status: "UNKNOWN", live_tp1_hit: false, live_tp2_hit: false, live_tp3_hit: false, live_stop_hit: false };
  }

  let tp1Hit = false, tp2Hit = false, tp3Hit = false, stopHit = false;

  if (decision === "LONG") {
    if (tp1 != null && current >= tp1) tp1Hit = true;
    if (tp2 != null && current >= tp2) tp2Hit = true;
    if (tp3 != null && current >= tp3) tp3Hit = true;
    if (stop != null && current <= stop) stopHit = true;
  } else {
    if (tp1 != null && current <= tp1) tp1Hit = true;
    if (tp2 != null && current <= tp2) tp2Hit = true;
    if (tp3 != null && current <= tp3) tp3Hit = true;
    if (stop != null && current >= stop) stopHit = true;
  }

  // Priority: STOPPED > TP3 > TP2 > TP1 > OPEN
  let status = "OPEN";
  if (stopHit) status = "STOPPED";
  else if (tp3Hit) status = "TP3_HIT";
  else if (tp2Hit) status = "TP2_HIT";
  else if (tp1Hit) status = "TP1_HIT";

  return { live_status: status, live_tp1_hit: tp1Hit, live_tp2_hit: tp2Hit, live_tp3_hit: tp3Hit, live_stop_hit: stopHit };
}

function computePctToTp1(
  decision: string,
  current: number | null,
  entry: number | null,
  tp1: number | null
): number | null {
  if (current == null || entry == null || tp1 == null) return null;
  if (decision === "LONG") {
    const range = tp1 - entry;
    if (range === 0) return null;
    return ((current - entry) / range) * 100;
  } else {
    const range = entry - tp1;
    if (range === 0) return null;
    return ((entry - current) / range) * 100;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeNum(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: NextRequest) {
  const supabase = getSupabase();
  const { searchParams } = req.nextUrl;

  const hours = Number(searchParams.get("hours") || "24");
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const tier = searchParams.get("tier");

  function buildQuery(columns: string) {
    let q = supabase
      .from("decisions")
      .select(columns)
      .in("decision", ["LONG", "SHORT"])
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(100);

    if (tier === "strict") {
      q = q.not("alert_type", "ilike", "%_RELAXED");
    } else if (tier === "relaxed") {
      q = q.ilike("alert_type", "%_RELAXED");
    }
    return q;
  }

  // Finalize any clusters whose selection window has expired (lazy evaluation).
  // Non-blocking: if it fails, we still return stale selection data.
  await finalizeExpiredClusters().catch((err) => {
    console.warn("[active-signals] cluster finalization failed (non-blocking):", err);
  });

  // Try extended columns first; fall back to base if migration not applied.
  let hasExtendedSchema = true;
  const extResult = await buildQuery(EXTENDED_COLUMNS);

  let decisions = extResult.data;
  let error = extResult.error;

  if (error && error.message.includes("does not exist")) {
    // Migration 014 not applied — fall back to base columns
    hasExtendedSchema = false;
    const fallback = await buildQuery(BASE_COLUMNS);
    decisions = fallback.data;
    error = fallback.error;
  }

  // Extract unique symbols from decisions, then fetch prices for those only
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uniqueSymbols = Array.from(new Set((decisions ?? []).map((d: any) => d.symbol as string)));
  const { prices, source: priceSource } = await fetchAllPrices(uniqueSymbols);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Two status concepts coexist in the response:
  //   status:         live operational indicator derived from current price vs levels.
  //                   Ephemeral, recalculated on each request. Not persisted.
  //   graded_outcome: durable research truth set by the grading job. Once set, it is
  //                   protected from re-grading overwrite (first-hit semantics).
  //                   Manual DB repair is the only way to change a resolved outcome.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signals = (decisions ?? []).map((d: any) => {
    const isRelaxed = /_RELAXED$/i.test(d.alert_type);
    const derivedTier = isRelaxed ? "RELAXED" : "STRICT";
    const setupFamily = d.alert_type.replace(/_RELAXED$|_DATA$/i, "");

    const currentPrice = prices.get(d.symbol) ?? null;
    const live = computeLiveStatus(
      d.decision,
      currentPrice,
      d.entry_price,
      d.stop_price,
      d.tp1_price,
      d.tp2_price,
      d.tp3_price
    );
    const pctToTp1 = computePctToTp1(
      d.decision,
      currentPrice,
      d.entry_price,
      d.tp1_price
    );

    // Composite score: use persisted value, fall back to on-the-fly computation
    let score = safeNum(d.composite_score);
    if (score == null) {
      const fallback = computeCompositeScore({
        rr_tp1: safeNum(d.rr_tp1),
        vol_ratio: safeNum(d.vol_ratio),
        alert_type: d.alert_type,
        entry_price: safeNum(d.entry_price),
        mark_price: currentPrice,
      });
      score = fallback.composite_score;
    }

    return {
      id: d.id,
      symbol: d.symbol,
      decision: d.decision,
      alert_type: d.alert_type,
      setup_family: setupFamily,
      tier: derivedTier,
      alert_tf: d.alert_tf,
      created_at: d.created_at,
      entry_price: d.entry_price,
      stop_price: d.stop_price,
      tp1_price: d.tp1_price,
      tp2_price: d.tp2_price,
      tp3_price: d.tp3_price,
      rr_tp1: d.rr_tp1,
      current_price: currentPrice,
      // Live status layer (ephemeral, from current price — NOT grading truth)
      status: live.live_status,
      live_status: live.live_status,
      live_tp1_hit: live.live_tp1_hit,
      live_tp2_hit: live.live_tp2_hit,
      live_tp3_hit: live.live_tp3_hit,
      live_stop_hit: live.live_stop_hit,
      pct_to_tp1: pctToTp1,
      score,
      // Cluster metadata (null-safe for pre-migration rows)
      cluster_id: d.cluster_id ?? null,
      cluster_size: d.cluster_size ?? 1,
      cluster_rank: d.cluster_rank ?? null,
      // Execution selection
      selected_for_execution: d.selected_for_execution ?? false,
      suppressed_reason: d.suppressed_reason ?? null,
      // Derived: pending if in a cluster but no selection decision yet
      selection_pending: d.cluster_id != null && d.selected_for_execution !== true && d.suppressed_reason == null,
      // Graded outcome (research, distinct from live status)
      graded_outcome: d.graded_outcome ?? null,
      // Lifecycle timestamps
      tp1_hit_at: d.tp1_hit_at ?? null,
      tp2_hit_at: d.tp2_hit_at ?? null,
      tp3_hit_at: d.tp3_hit_at ?? null,
      stopped_at: d.stopped_at ?? null,
      resolved_at: d.resolved_at ?? null,
      // Existing fields
      telegram_sent: d.telegram_sent ?? false,
      telegram_attempted: d.telegram_attempted ?? false,
      blocked_reason: d.blocked_reason ?? null,
      gate_a_quality: d.gate_a_quality ?? null,
      gate_b_passed: d.gate_b_passed ?? false,
    };
  });

  return NextResponse.json({
    signals,
    count: signals.length,
    prices_loaded: prices.size > 0,
    price_source: priceSource,
    schema_version: hasExtendedSchema ? "014" : "base",
  });
}
