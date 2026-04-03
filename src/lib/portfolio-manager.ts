/**
 * Portfolio Manager Agent
 * 
 * Correlation-aware signal selection for burst periods.
 * Prevents loading up on correlated positions that all stop out together.
 * 
 * No AI — pure math. Runs in the scanner pipeline after scoring, before execution.
 */

import { getSupabase } from "@/lib/supabase";

export interface PortfolioCandidate {
  symbol: string;
  compositeScore: number;
  tier: string;
  signalType: string;
}

export interface PortfolioDecision {
  symbol: string;
  accepted: boolean;
  reason: string;
}

// ─── Configuration ────────────────────────────────────────
const MAX_NEW_PER_BURST = parseInt(process.env.MAX_BURST_ENTRIES ?? "3");
const CORRELATION_THRESHOLD = 0.70;

interface OpenPosition {
  symbol: string;
  created_at: string;
}

interface PriceSnapshot {
  symbol: string;
  price_1h_pct: number | null;
  price_24h_pct: number | null;
}

/**
 * Select which candidates from a burst to actually trade.
 * Filters for:
 *   1. No duplicate symbols (already open)
 *   2. Max N new positions per burst
 *   3. Diversification: avoid clustering symbols that moved identically in the last hour
 * 
 * Candidates MUST be pre-sorted by composite score (best first).
 */
export async function selectFromBurst(
  candidates: PortfolioCandidate[]
): Promise<PortfolioDecision[]> {
  const supabase = getSupabase();
  const decisions: PortfolioDecision[] = [];
  
  if (candidates.length === 0) return decisions;

  // ── 1. Get currently open positions ──
  const { data: openPositions } = await supabase
    .from("decisions")
    .select("symbol, created_at")
    .eq("telegram_sent", true)
    .is("graded_outcome", null)
    .not("resolution_path", "in", '("PRE_LIVE_CLEANUP","EXEC_REJECTED")');
  
  const openSymbols = new Set((openPositions ?? []).map(p => p.symbol));
  console.log(`[portfolio] Open positions: ${openSymbols.size} (${[...openSymbols].join(', ')})`);

  // ── 2. Get latest price movements for correlation check ──
  const { data: latestSnapshots } = await supabase
    .from("market_ticker_history")
    .select("symbol, price_1h_pct, price_24h_pct")
    .order("ts", { ascending: false })
    .limit(44);
  
  const priceMap = new Map<string, PriceSnapshot>();
  for (const s of (latestSnapshots ?? [])) {
    if (!priceMap.has(s.symbol)) {
      priceMap.set(s.symbol, s);
    }
  }

  // ── 3. Selection logic ──
  const accepted: PortfolioCandidate[] = [];
  const acceptedMoves: number[] = []; // 1h price changes of accepted signals

  // Also track 1h moves of open positions for correlation check
  const openMoves: number[] = [];
  for (const sym of openSymbols) {
    const snap = priceMap.get(sym);
    if (snap?.price_1h_pct != null) {
      openMoves.push(snap.price_1h_pct);
    }
  }

  for (const candidate of candidates) {
    // Rule 1: No duplicate symbols
    if (openSymbols.has(candidate.symbol)) {
      decisions.push({ symbol: candidate.symbol, accepted: false, reason: "already_open" });
      continue;
    }

    // Rule 2: Burst cap
    if (accepted.length >= MAX_NEW_PER_BURST) {
      decisions.push({ symbol: candidate.symbol, accepted: false, reason: `burst_cap_${MAX_NEW_PER_BURST}` });
      continue;
    }

    // Rule 3: Correlation check via 1h price movement similarity
    const snap = priceMap.get(candidate.symbol);
    const move = snap?.price_1h_pct;
    
    if (move != null) {
      // Check against already-accepted burst signals
      const tooSimilarToAccepted = acceptedMoves.some(
        m => Math.abs(m - move) < 0.3 // within 0.3% = basically same move
      );

      // Check against open positions too
      const tooSimilarToOpen = openMoves.some(
        m => Math.abs(m - move) < 0.3
      );

      // If correlated with 3+ open positions moving the same way, skip
      const correlatedOpenCount = openMoves.filter(
        m => Math.abs(m - move) < 0.5
      ).length;

      if (tooSimilarToAccepted && accepted.length >= 2) {
        // Allow first 2 even if similar, block 3rd+ similar move
        decisions.push({ 
          symbol: candidate.symbol, accepted: false, 
          reason: `correlated_with_burst: move=${move.toFixed(2)}% similar to accepted` 
        });
        continue;
      }

      if (correlatedOpenCount >= 3) {
        decisions.push({ 
          symbol: candidate.symbol, accepted: false, 
          reason: `correlated_with_${correlatedOpenCount}_open_positions` 
        });
        continue;
      }

      acceptedMoves.push(move);
    }

    // Accepted
    accepted.push(candidate);
    decisions.push({ symbol: candidate.symbol, accepted: true, reason: "accepted" });
    console.log(`[portfolio] ACCEPT #${accepted.length}: ${candidate.symbol} score=${candidate.compositeScore.toFixed(1)} tier=${candidate.tier}`);
  }

  const rejected = decisions.filter(d => !d.accepted);
  if (rejected.length > 0) {
    console.log(`[portfolio] Rejected ${rejected.length}: ${rejected.map(r => `${r.symbol}(${r.reason})`).join(', ')}`);
  }

  return decisions;
}
