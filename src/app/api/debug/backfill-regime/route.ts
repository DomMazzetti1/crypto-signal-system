import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { fetchKlines } from "@/lib/bybit";
import { classifyRegimeFromCandles } from "@/lib/regime";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getSupabase();

  // Fetch decisions missing regime data, oldest first
  const { data: rows, error } = await supabase
    .from("decisions")
    .select("id, created_at, btc_regime")
    .or("btc_regime.is.null,btc_regime.eq.unknown,btc_regime.eq.")
    .in("decision", ["LONG", "SHORT"])
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) return NextResponse.json({ status: "done", updated: 0 });

  // Fetch BTC candles once — enough history to cover the full date range
  let btc4h, btc1d;
  try {
    [btc4h, btc1d] = await Promise.all([
      fetchKlines("BTCUSDT", "240", 1000),  // ~167 days of 4H
      fetchKlines("BTCUSDT", "D", 400),     // 400 days of daily
    ]);
  } catch (err) {
    return NextResponse.json({ error: `BTC fetch failed: ${err}` }, { status: 502 });
  }

  let updated = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const signalTime = new Date(row.created_at).getTime();

    // Slice BTC candles to only those available AT the time of the signal
    const btc4hAtTime = btc4h.filter(c => c.startTime <= signalTime);
    const btc1dAtTime = btc1d.filter(c => c.startTime <= signalTime);

    if (btc4hAtTime.length < 14 || btc1dAtTime.length < 200) {
      errors.push(`${row.id}: insufficient candle history at ${row.created_at}`);
      continue;
    }

    const slice4h = btc4hAtTime.slice(-50);
    const slice1d = btc1dAtTime.slice(-220);

    try {
      const regime = classifyRegimeFromCandles(slice4h, slice1d);

      const { error: updateErr } = await supabase
        .from("decisions")
        .update({
          btc_regime: regime.btc_regime,
          alt_environment: regime.alt_environment,
        })
        .eq("id", row.id);

      if (updateErr) {
        errors.push(`${row.id}: update failed — ${updateErr.message}`);
      } else {
        updated++;
      }
    } catch (err) {
      errors.push(`${row.id}: regime classification failed — ${err}`);
    }
  }

  return NextResponse.json({
    status: updated > 0 ? "completed" : "partial",
    processed: rows.length,
    updated,
    errors: errors.length > 0 ? errors : undefined,
    note: rows.length === 50 ? "hit batch limit — call again to continue" : "batch complete",
  });
}
