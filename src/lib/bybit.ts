const BYBIT_BASE = "https://api.bybit.com/v5/market";

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
  const data = await res.json();
  if (data.retCode !== 0 || !data.result.list.length) {
    throw new Error(`Ticker fetch failed for ${symbol}: ${data.retMsg}`);
  }
  return data.result.list[0];
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
  const data = await res.json();
  if (data.retCode !== 0) {
    throw new Error(`Orderbook fetch failed for ${symbol}: ${data.retMsg}`);
  }
  return {
    ts: data.result.ts,
    bids: data.result.b,
    asks: data.result.a,
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
  const data = await res.json();
  if (data.retCode !== 0) {
    throw new Error(`OI fetch failed for ${symbol} (${intervalTime}): ${data.retMsg}`);
  }
  return data.result.list;
}

// ── Derived calculations ────────────────────────────────

export function computeSpreadBps(bid: string, ask: string): number {
  const b = parseFloat(bid);
  const a = parseFloat(ask);
  if (b === 0 || a === 0) return 0;
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
