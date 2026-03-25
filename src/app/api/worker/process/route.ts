import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getRedis, ALERTS_QUEUE_KEY } from "@/lib/redis";
import { runPipeline, AlertPayload } from "@/lib/pipeline";

export async function POST() {
  const redis = getRedis();
  const supabase = getSupabase();

  // Pop one alert from queue (FIFO)
  const raw = await redis.rpop<string>(ALERTS_QUEUE_KEY);
  if (!raw) {
    return NextResponse.json({ status: "empty", message: "No alerts in queue" });
  }

  let alert: AlertPayload;
  try {
    alert = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    console.error("Failed to parse alert from queue:", raw);
    return NextResponse.json({ error: "Corrupt queue entry" }, { status: 500 });
  }

  // Find matching unprocessed alert_id
  const { data: rawRow } = await supabase
    .from("alerts_raw")
    .select("id")
    .eq("processed", false)
    .contains("payload", { symbol: alert.symbol, type: alert.type })
    .order("received_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const alertId: string | null = rawRow?.id ?? null;

  const result = await runPipeline(alert, alertId);

  const httpStatus = result.http_status ?? 200;
  delete result.http_status;

  return NextResponse.json(result, { status: httpStatus });
}
