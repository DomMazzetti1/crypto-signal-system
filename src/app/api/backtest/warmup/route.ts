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

// ── Single-symbol warmup ────────────────────────────────

async function warmSymbol(symbol: string): Promise<{
  symbol: string;
  intervals: Record<string, { fetched: number; cached: number }>;
  runtime_ms: number;
  error?: string;
}> {
  const t0 = Date.now();
  const intervals: Record<string, { fetched: number; cached: number }> = {};

  try {
    for (const interval of INTERVALS) {
      const target = TARGET_CANDLES[interval];
      const candles = await fetchFromBybit(symbol, interval, target);
      const written = await writeCache(symbol, interval, candles);
      intervals[interval] = { fetched: candles.length, cached: written };
      // Small delay between timeframes to avoid rate limits
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err) {
    return { symbol, intervals, runtime_ms: Date.now() - t0, error: String(err).slice(0, 120) };
  }

  return { symbol, intervals, runtime_ms: Date.now() - t0 };
}

// ── Main handler ────────────────────────────────────────

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const symbol = request.nextUrl.searchParams.get("symbol")?.toUpperCase();
  const mode = request.nextUrl.searchParams.get("mode");

  // Bulk mode: warm all eligible symbols sequentially
  if (mode === "bulk") {
    return runBulkWarmup(startTime);
  }

  // Single-symbol mode (existing behavior)
  if (!symbol) {
    return NextResponse.json(
      { error: "Missing ?symbol= parameter. Use ?symbol=BTCUSDT or ?mode=bulk for all." },
      { status: 400 }
    );
  }

  console.log(`[warmup] Starting cache warmup for ${symbol}`);
  const result = await warmSymbol(symbol);
  console.log(`[warmup] ${symbol} complete in ${(result.runtime_ms / 1000).toFixed(1)}s`);

  return NextResponse.json(result);
}

// ── Bulk warmup ─────────────────────────────────────────

async function runBulkWarmup(startTime: number): Promise<NextResponse> {
  const supabase = getSupabase();

  const { data: rows, error: uniErr } = await supabase
    .from("universe")
    .select("symbol")
    .eq("is_eligible", true)
    .order("symbol");

  if (uniErr || !rows) {
    return NextResponse.json({ error: "Failed to read universe" }, { status: 500 });
  }

  const symbols = rows.map((r) => r.symbol);
  const completed: { symbol: string; intervals: Record<string, { fetched: number; cached: number }>; runtime_ms: number }[] = [];
  const failed: { symbol: string; error: string }[] = [];

  console.log(`[warmup-bulk] Starting: ${symbols.length} symbols`);

  // Process 2 symbols at a time to stay under rate limits
  for (let i = 0; i < symbols.length; i += 2) {
    const batch = symbols.slice(i, i + 2);
    const results = await Promise.all(batch.map(warmSymbol));

    for (const r of results) {
      if (r.error) {
        failed.push({ symbol: r.symbol, error: r.error });
        console.log(`[warmup-bulk] ${r.symbol} FAILED: ${r.error}`);
      } else {
        completed.push({ symbol: r.symbol, intervals: r.intervals, runtime_ms: r.runtime_ms });
        console.log(`[warmup-bulk] ${r.symbol} done (${(r.runtime_ms / 1000).toFixed(1)}s) — ${completed.length}/${symbols.length}`);
      }
    }

    // Check if approaching Vercel timeout (leave 15s buffer)
    if (Date.now() - startTime > 280_000) {
      const remaining = symbols.slice(i + 2);
      console.log(`[warmup-bulk] Timeout approaching, stopping with ${remaining.length} symbols remaining`);
      return NextResponse.json({
        status: "partial",
        completed: completed.length,
        failed: failed.length,
        remaining: remaining.length,
        remaining_symbols: remaining,
        results: completed,
        errors: failed,
        runtime_ms: Date.now() - startTime,
        hint: "Re-run ?mode=bulk to continue. Already-cached symbols will be fast on next backtest.",
      });
    }

    // Small delay between batches
    if (i + 2 < symbols.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const runtimeMs = Date.now() - startTime;
  console.log(`[warmup-bulk] Complete: ${completed.length} warmed, ${failed.length} failed, ${(runtimeMs / 1000).toFixed(1)}s`);

  return NextResponse.json({
    status: "complete",
    completed: completed.length,
    failed: failed.length,
    results: completed,
    errors: failed.length > 0 ? failed : undefined,
    runtime_ms: runtimeMs,
  });
}
