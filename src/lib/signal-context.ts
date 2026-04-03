/**
 * Signal Context Enrichment
 * 
 * Queries the latest market context from the data collector's tables
 * and attaches it to signals at fire time. This context is stored with
 * the decision for later analysis by the quant researcher.
 */

import { getSupabase } from "@/lib/supabase";

export interface SignalContext {
  funding_rate: number | null;
  funding_interval: number | null;
  oi_delta_1h_pct: number | null;
  oi_delta_4h_pct: number | null;
  spread_pct: number | null;
  btc_correlation: number | null;
  btc_beta: number | null;
}

const EMPTY_CONTEXT: SignalContext = {
  funding_rate: null, funding_interval: null,
  oi_delta_1h_pct: null, oi_delta_4h_pct: null,
  spread_pct: null, btc_correlation: null, btc_beta: null,
};

/**
 * Get enrichment context for a symbol at signal time.
 * Queries both raw ticker and derived metrics tables.
 * Returns EMPTY_CONTEXT if data collector isn't running.
 */
export async function getSignalContext(symbol: string): Promise<SignalContext> {
  const supabase = getSupabase();

  try {
    // Get latest raw ticker data (funding, spread)
    const { data: ticker } = await supabase
      .from("market_ticker_history")
      .select("funding_rate, funding_interval_hours, spread_pct")
      .eq("symbol", symbol)
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Get latest derived metrics (OI delta, BTC beta, correlation)
    const { data: derived } = await supabase
      .from("market_derived_metrics")
      .select("oi_delta_1h_pct, oi_delta_4h_pct, btc_beta_24h, btc_correlation_24h")
      .eq("symbol", symbol)
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Only use data if it's fresh (within last 30 min)
    const context: SignalContext = {
      funding_rate: ticker?.funding_rate ?? null,
      funding_interval: ticker?.funding_interval_hours ?? null,
      oi_delta_1h_pct: derived?.oi_delta_1h_pct ?? null,
      oi_delta_4h_pct: derived?.oi_delta_4h_pct ?? null,
      spread_pct: ticker?.spread_pct ?? null,
      btc_correlation: derived?.btc_correlation_24h ?? null,
      btc_beta: derived?.btc_beta_24h ?? null,
    };

    return context;
  } catch (err) {
    console.warn(`[signal-context] Failed to get context for ${symbol}:`, err);
    return EMPTY_CONTEXT;
  }
}
