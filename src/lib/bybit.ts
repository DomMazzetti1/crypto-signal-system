const BYBIT_BASE = "https://api.bybit.com/v5/market";

// ── Safe JSON parser for Bybit responses ────────────────

export async function parseBybitResponse(
  res: Response,
  label: string
): Promise<{ retCode: number; retMsg: string; result: Record<string, unknown> }> {
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const preview = (await res.text()).slice(0, 200);
    throw new Error(`${label}: expected JSON, got ${contentType}: ${preview}`);
  }
  let data: { retCode: number; retMsg: string; result: Record<string, unknown> };
  try {
    data = await res.json();
  } catch {
    throw new Error(`${label}: invalid JSON body`);
  }
  return data;
}

// ── Ticker ──────────────────────────────────────────────

export interface TickerData {
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  nextFundingTime: string;
  openInterest: string;
  openInterestValue: string;
  turnover24h: string;
  bid1Price: string;
  ask1Price: string;
}

export async function fetchTicker(symbol: string): Promise<TickerData> {
  const res = await fetch(
    `${BYBIT_BASE}/tickers?category=linear&symbol=${symbol}`,
    { cache: "no-store" }
  );
  const data = await parseBybitResponse(res, `Ticker ${symbol}`);
  const list = data.result.list as unknown[];
  if (data.retCode !== 0 || !list?.length) {
    throw new Error(`Ticker fetch failed for ${symbol}: ${data.retMsg}`);
  }
  return (list as TickerData[])[0];
}

// ── Orderbook ───────────────────────────────────────────

interface OrderbookLevel {
  0: string; // price
  1: string; // size
}

export interface OrderbookData {
  ts: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

export async function fetchOrderbook(symbol: string): Promise<OrderbookData> {
  const res = await fetch(
    `${BYBIT_BASE}/orderbook?category=linear&symbol=${symbol}&limit=20`,
    { cache: "no-store" }
  );
  const data = await parseBybitResponse(res, `Orderbook ${symbol}`);
  if (data.retCode !== 0) {
    throw new Error(`Orderbook fetch failed for ${symbol}: ${data.retMsg}`);
  }
  return {
    ts: data.result.ts as number,
    bids: data.result.b as OrderbookLevel[],
    asks: data.result.a as OrderbookLevel[],
  };
}

// ── Open Interest History ───────────────────────────────

interface OIRecord {
  openInterest: string;
  timestamp: string;
}

export async function fetchOIHistory(
  symbol: string,
  intervalTime: string
): Promise<OIRecord[]> {
  const res = await fetch(
    `${BYBIT_BASE}/open-interest?category=linear&symbol=${symbol}&intervalTime=${intervalTime}&limit=2`,
    { cache: "no-store" }
  );
  const data = await parseBybitResponse(res, `OI ${symbol} (${intervalTime})`);
  if (data.retCode !== 0) {
    throw new Error(`OI fetch failed for ${symbol} (${intervalTime}): ${data.retMsg}`);
  }
  return data.result.list as OIRecord[];
}

// ── Derived calculations ────────────────────────────────

export function computeSpreadBps(bid: string, ask: string): number {
  const b = parseFloat(bid);
  const a = parseFloat(ask);
  if (!Number.isFinite(b) || !Number.isFinite(a) || b === 0 || a === 0) return 0;
  const mid = (b + a) / 2;
  return ((a - b) / mid) * 10_000;
}

export function computeBookDepthUsd(
  levels: OrderbookLevel[],
  markPrice: number
): number {
  return levels.reduce((sum, lvl) => {
    const size = parseFloat(lvl[1]);
    return sum + size * markPrice;
  }, 0);
}

export function computeOIDelta(records: OIRecord[]): number | null {
  if (records.length < 2) return null;
  const latest = parseFloat(records[0].openInterest);
  const previous = parseFloat(records[1].openInterest);
  if (previous === 0) return null;
  return ((latest - previous) / previous) * 100;
}

// ── Kline (candlestick) data ────────────────────────────

export interface Kline {
  startTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
  endTimeMs?: number
): Promise<Kline[]> {
  const params = new URLSearchParams({
    category: "linear",
    symbol,
    interval,
    limit: String(limit),
  });
  if (typeof endTimeMs === "number" && Number.isFinite(endTimeMs)) {
    params.set("end", String(endTimeMs));
  }

  const res = await fetch(`${BYBIT_BASE}/kline?${params.toString()}`, {
    cache: "no-store",
  });
  const data = await parseBybitResponse(res, `Kline ${symbol} (${interval})`);
  if (data.retCode !== 0) {
    throw new Error(`Kline fetch failed for ${symbol} (${interval}): ${data.retMsg}`);
  }
  const list = data.result.list as string[][];
  // Bybit returns [startTime, open, high, low, close, volume, turnover]
  // Results are newest-first, reverse to chronological order
  return list
    .map((k: string[]) => ({
      startTime: Number(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }))
    .reverse();
}
