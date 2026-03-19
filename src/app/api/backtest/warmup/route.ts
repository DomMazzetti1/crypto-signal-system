import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TARGET_CANDLES: Record<string, number> = {
  "60": 8760,
  "240": 2190,
  "D": 400,
};

const BYBIT_BATCH = 1000;
const INTERVALS = ["60", "240", "D"] as const;

// ── Fetch from Bybit API (raw paginated) ────────────────

async function fetchFromBybit(
  symbol: string,
  interval: string,
  target: number
): Promise<Kline[]> {
  const allCandles: Map<number, Kline> = new Map();
  let end: number | undefined = undefined;

  while (allCandles.size < target) {
    const batchSize = Math.min(BYBIT_BATCH, target - allCandles.size);
    let url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${batchSize}`;
    if (end !== undefined) {
      url += `&end=${end}`;
    }

    let data: { retCode: number; retMsg: string; result: { list: string[][] } };
    try {
      const res = await fetch(url, { cache: "no-store" });
      data = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(url, { cache: "no-store" });
      data = await res.json();
    }

    if (data.retCode !== 0) {
      throw new Error(`Kline fetch failed for ${symbol} (${interval}): ${data.retMsg}`);
    }

    const batch = data.result.list;
    if (batch.length === 0) break;

    for (const k of batch) {
      const startTime = Number(k[0]);
      if (!allCandles.has(startTime)) {
        allCandles.set(startTime, {
          startTime,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
      }
    }

    const earliestTime = Number(batch[batch.length - 1][0]);
    if (end !== undefined && earliestTime >= end) break;
    end = earliestTime - 1;
  }

  return Array.from(allCandles.values()).sort((a, b) => a.startTime - b.startTime);
}

// ── Write candles to cache ──────────────────────────────

async function writeCache(
  symbol: string,
  interval: string,
  candles: Kline[]
): Promise<number> {
  if (candles.length === 0) return 0;
  const supabase = getSupabase();
  let written = 0;

  for (let i = 0; i < candles.length; i += 500) {
    const batch = candles.slice(i, i + 500).map((c) => ({
      symbol,
      interval,
      start_time: new Date(c.startTime).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    const { error } = await supabase
      .from("candle_cache")
      .upsert(batch, { onConflict: "symbol,interval,start_time", ignoreDuplicates: true });
    if (!error) written += batch.length;
  }

  return written;
}

// ── Main handler ────────────────────────────────────────

export async function GET(request: NextRequest) {
  const startTime = Date.now();

  const symbol = request.nextUrl.searchParams.get("symbol")?.toUpperCase();
  if (!symbol) {
    return NextResponse.json(
      { error: "Missing ?symbol= parameter, e.g. ?symbol=BTCUSDT" },
      { status: 400 }
    );
  }

  console.log(`[warmup] Starting cache warmup for ${symbol}`);

  const results: Record<string, { fetched: number; cached: number }> = {};

  for (const interval of INTERVALS) {
    const target = TARGET_CANDLES[interval];
    console.log(`[warmup] ${symbol}/${interval}: fetching ${target} candles...`);

    const candles = await fetchFromBybit(symbol, interval, target);
    const written = await writeCache(symbol, interval, candles);

    results[interval] = { fetched: candles.length, cached: written };
    console.log(`[warmup] ${symbol}/${interval}: ${candles.length} fetched, ${written} cached`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[warmup] ${symbol} complete in ${(elapsed / 1000).toFixed(1)}s`);

  return NextResponse.json({
    symbol,
    intervals: results,
    runtime_ms: elapsed,
  });
}
