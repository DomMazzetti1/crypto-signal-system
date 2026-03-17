import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BYBIT_BASE = "https://api.bybit.com/v5/market";
const MIN_TURNOVER_24H = 10_000_000;
const MIN_OPEN_INTEREST = 2_000_000;
const MIN_AGE_DAYS = 45;

interface InstrumentInfo {
  symbol: string;
  status: string;
  contractType: string;
  launchTime: string;
}

interface TickerInfo {
  symbol: string;
  turnover24h: string;
  openInterest: string;
  bid1Price: string;
  ask1Price: string;
}

async function fetchInstruments(): Promise<InstrumentInfo[]> {
  const url = `${BYBIT_BASE}/instruments-info?category=linear`;
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();

  if (data.retCode !== 0) {
    throw new Error(`Bybit instruments-info error: ${data.retMsg}`);
  }

  return data.result.list;
}

async function fetchTicker(symbol: string): Promise<TickerInfo | null> {
  const url = `${BYBIT_BASE}/tickers?category=linear&symbol=${symbol}`;
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();

  if (data.retCode !== 0 || !data.result.list.length) {
    return null;
  }

  return data.result.list[0];
}

function computeSpreadBps(bid: string, ask: string): number {
  const b = parseFloat(bid);
  const a = parseFloat(ask);
  if (b === 0 || a === 0) return 0;
  const mid = (b + a) / 2;
  return ((a - b) / mid) * 10_000;
}

export async function GET() {
  const supabase = getSupabase();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MIN_AGE_DAYS);

  let instruments: InstrumentInfo[];
  try {
    instruments = await fetchInstruments();
  } catch (err) {
    console.error("Failed to fetch instruments:", err);
    return NextResponse.json(
      { error: "Failed to fetch instruments from Bybit" },
      { status: 502 }
    );
  }

  // Filter for active linear perpetuals
  const candidates = instruments.filter(
    (i) => i.status === "Trading" && i.contractType === "LinearPerpetual"
  );

  let eligible = 0;
  const now = new Date().toISOString();

  for (const inst of candidates) {
    const launchTime = new Date(Number(inst.launchTime));

    // Must have been launched at least MIN_AGE_DAYS ago
    if (launchTime > cutoffDate) {
      await upsertUniverse(supabase, inst.symbol, {
        status: inst.status,
        launch_time: launchTime.toISOString(),
        is_eligible: false,
        last_checked_at: now,
      });
      continue;
    }

    const ticker = await fetchTicker(inst.symbol);
    if (!ticker) continue;

    const turnover = parseFloat(ticker.turnover24h);
    const oi = parseFloat(ticker.openInterest);
    const spreadBps = computeSpreadBps(ticker.bid1Price, ticker.ask1Price);

    const passes =
      turnover >= MIN_TURNOVER_24H && oi >= MIN_OPEN_INTEREST;

    if (passes) eligible++;

    await upsertUniverse(supabase, inst.symbol, {
      status: inst.status,
      launch_time: launchTime.toISOString(),
      turnover_24h: turnover,
      open_interest: oi,
      spread_bps: spreadBps,
      is_eligible: passes,
      last_checked_at: now,
    });
  }

  return NextResponse.json({
    total_scanned: candidates.length,
    total_eligible: eligible,
  });
}

async function upsertUniverse(
  supabase: ReturnType<typeof getSupabase>,
  symbol: string,
  data: Record<string, unknown>
) {
  const { error } = await supabase
    .from("universe")
    .upsert(
      { symbol, ...data, updated_at: new Date().toISOString() },
      { onConflict: "symbol" }
    );

  if (error) {
    console.error(`Failed to upsert ${symbol}:`, error);
  }
}
