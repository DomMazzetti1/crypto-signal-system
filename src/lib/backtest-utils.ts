/**
 * Shared backtest/research utilities.
 * Extracted from duplicated code across backtest routes.
 */

import { getSupabase } from "@/lib/supabase";
import { Kline } from "@/lib/bybit";
import { NextResponse } from "next/server";

// ── Concurrency limiter ─────────────────────────────────

export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Supabase candle cache reader ────────────────────────

export async function readCache(symbol: string, interval: string): Promise<Kline[]> {
  const supabase = getSupabase();
  const rows: Kline[] = [];
  let offset = 0;
  const PAGE = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("candle_cache")
      .select("start_time, open, high, low, close, volume")
      .eq("symbol", symbol)
      .eq("interval", interval)
      .order("start_time", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error || !data || data.length === 0) break;
    for (const r of data) {
      rows.push({
        startTime: new Date(r.start_time).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      });
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return rows;
}

// ── Production guardrails ───────────────────────────────

const isVercel = !!process.env.VERCEL;
const MAX_SYMBOLS_VERCEL = 5;

/**
 * Validates request parameters for heavy research endpoints running on Vercel.
 * Returns null if OK, or a NextResponse error to return immediately.
 */
export function enforceProductionLimits(
  symbols: string[],
  cacheOnly: boolean
): NextResponse | null {
  if (!isVercel) return null; // No limits locally

  if (!cacheOnly) {
    return NextResponse.json({
      error: "cache_only is required on Vercel to avoid Bybit timeouts",
      hint: 'Add "cache_only": true to your request body. Run locally for live fetches.',
    }, { status: 400 });
  }

  if (symbols.length > MAX_SYMBOLS_VERCEL) {
    return NextResponse.json({
      error: `Too many symbols (${symbols.length}) for Vercel. Max ${MAX_SYMBOLS_VERCEL} in production.`,
      hint: "Run locally for full-universe backtests, or pass a smaller symbols array.",
    }, { status: 400 });
  }

  return null;
}

// ── Rounding helper ─────────────────────────────────────

export function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
