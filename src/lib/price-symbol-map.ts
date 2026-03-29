/**
 * Mapping from Bybit perpetual trading symbols to CoinGecko IDs.
 *
 * Used by the dashboard price fetch to get current prices from CoinGecko
 * when direct Bybit access is unavailable.
 *
 * Symbols not in this map will have no CoinGecko price (null).
 * The 1000-prefixed symbols (1000BONKUSDT, 1000PEPEUSDT) represent
 * 1000x the underlying token — the price is divided by 1000 after fetch.
 */

// CoinGecko ID -> trading symbol(s) that use this ID
// Some tokens trade as 1000X on Bybit (price = coingecko * 1000)
const COINGECKO_MAP: Record<string, string> = {
  // ── Major / well-known ──────────────────────────────
  BTCUSDT: "bitcoin",
  ETHUSDT: "ethereum",
  SOLUSDT: "solana",
  DOGEUSDT: "dogecoin",
  ADAUSDT: "cardano",
  DOTUSDT: "polkadot",
  AVAXUSDT: "avalanche-2",
  LINKUSDT: "chainlink",
  NEARUSDT: "near",
  APTUSDT: "aptos",
  ARBUSDT: "arbitrum",
  SEIUSDT: "sei-network",
  RENDERUSDT: "render-token",
  OPUSDT: "optimism",
  ONDOUSDT: "ondo-finance",
  ENAUSDT: "ethena",
  CRVUSDT: "curve-dao-token",
  GALAUSDT: "gala",
  ANKRUSDT: "ankr",
  KNCUSDT: "kyber-network-crystal",
  HYPEUSDT: "hyperliquid",

  // ── Meme / smaller ─────────────────────────────────
  FARTCOINUSDT: "fartcoin",
  PENGUUSDT: "pudgy-penguins",
  PIXELUSDT: "pixels",

  // ── 1000x tokens (Bybit trades at 1000x the underlying) ──
  "1000BONKUSDT": "bonk",
  "1000PEPEUSDT": "pepe",
};

// Symbols that are 1000x the CoinGecko price
const THOUSAND_X_SYMBOLS = new Set(["1000BONKUSDT", "1000PEPEUSDT"]);

/**
 * Given a list of trading symbols, returns the CoinGecko IDs needed
 * and a reverse mapping to convert results back.
 */
export function resolveSymbols(symbols: string[]): {
  /** Unique CoinGecko IDs to fetch */
  geckoIds: string[];
  /** Map from CoinGecko ID back to { symbol, multiplier } */
  reverseMap: Map<string, { symbol: string; multiplier: number }>;
  /** Symbols that have no CoinGecko mapping */
  unmapped: string[];
} {
  const reverseMap = new Map<string, { symbol: string; multiplier: number }>();
  const unmapped: string[] = [];
  const idSet = new Set<string>();

  for (const sym of symbols) {
    const geckoId = COINGECKO_MAP[sym];
    if (!geckoId) {
      unmapped.push(sym);
      continue;
    }
    idSet.add(geckoId);
    const multiplier = THOUSAND_X_SYMBOLS.has(sym) ? 1000 : 1;
    reverseMap.set(`${geckoId}:${sym}`, { symbol: sym, multiplier });
  }

  return {
    geckoIds: Array.from(idSet),
    reverseMap,
    unmapped,
  };
}

/**
 * Converts a CoinGecko price response into a Map<tradingSymbol, price>.
 *
 * @param geckoResponse - The raw { [geckoId]: { usd: number } } response
 * @param symbols - The original trading symbols requested
 */
export function mapGeckoPrices(
  geckoResponse: Record<string, { usd?: number }>,
  symbols: string[]
): Map<string, number> {
  const map = new Map<string, number>();

  for (const sym of symbols) {
    const geckoId = COINGECKO_MAP[sym];
    if (!geckoId) continue;

    const entry = geckoResponse[geckoId];
    if (!entry || entry.usd == null) continue;

    const raw = entry.usd;
    if (!Number.isFinite(raw)) continue;

    const multiplier = THOUSAND_X_SYMBOLS.has(sym) ? 1000 : 1;
    map.set(sym, raw * multiplier);
  }

  return map;
}
