import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getRedis, ALERTS_QUEUE_KEY } from "@/lib/redis";

const REQUIRED_FIELDS = [
  "type",
  "symbol",
  "tf",
  "price",
  "rsi",
  "adx1h",
  "adx4h",
  "bb_width",
] as const;

export async function POST(request: NextRequest) {
  let payload: Record<string, unknown>;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const missing = REQUIRED_FIELDS.filter((f) => !(f in payload));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  // Store raw payload to Postgres
  const { error: dbError } = await getSupabase()
    .from("alerts_raw")
    .insert({ payload });

  if (dbError) {
    console.error("Failed to insert alert_raw:", dbError);
    return NextResponse.json(
      { error: "Database insert failed" },
      { status: 500 }
    );
  }

  // Push to Redis queue
  await getRedis().lpush(ALERTS_QUEUE_KEY, JSON.stringify(payload));

  return NextResponse.json({ status: "queued" }, { status: 200 });
}
