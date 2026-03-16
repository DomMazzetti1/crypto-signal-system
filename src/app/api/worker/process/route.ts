import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getRedis, ALERTS_QUEUE_KEY } from "@/lib/redis";

interface AlertPayload {
  type: string;
  symbol: string;
  [key: string]: unknown;
}

export async function POST() {
  const redis = getRedis();
  const supabase = getSupabase();

  // Pop one alert from the right side of the queue (FIFO)
  const raw = await redis.rpop<string>(ALERTS_QUEUE_KEY);

  if (!raw) {
    return NextResponse.json(
      { status: "empty", message: "No alerts in queue" },
      { status: 200 }
    );
  }

  let alert: AlertPayload;
  try {
    alert = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    console.error("Failed to parse alert from queue:", raw);
    return NextResponse.json(
      { error: "Corrupt queue entry" },
      { status: 500 }
    );
  }

  console.log(`[worker] Processing alert: symbol=${alert.symbol} type=${alert.type}`);

  // Mark as processed in Postgres
  const { error } = await supabase
    .from("alerts_raw")
    .update({ processed: true })
    .eq("processed", false)
    .contains("payload", { symbol: alert.symbol, type: alert.type })
    .limit(1);

  if (error) {
    console.error("Failed to mark alert as processed:", error);
  }

  return NextResponse.json({ status: "processed", alert });
}
