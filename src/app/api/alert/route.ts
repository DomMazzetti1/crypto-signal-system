import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getRedis, ALERTS_QUEUE_KEY } from "@/lib/redis";
import { runPipeline, AlertPayload } from "@/lib/pipeline";

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

  const supabase = getSupabase();

  // Store raw payload to Postgres
  const { data: rawRow, error: dbError } = await supabase
    .from("alerts_raw")
    .insert({ payload })
    .select("id")
    .single();

  if (dbError) {
    console.error("Failed to insert alert_raw:", dbError);
    return NextResponse.json(
      { error: "Database insert failed" },
      { status: 500 }
    );
  }

  const alertId: string = rawRow.id;

  // Push to Redis queue (kept for audit / replay capability)
  await getRedis().lpush(ALERTS_QUEUE_KEY, JSON.stringify(payload));

  // Run full pipeline inline
  const alert = payload as unknown as AlertPayload;
  const result = await runPipeline(alert, alertId);

  const httpStatus = result.http_status ?? 200;
  delete result.http_status;

  return NextResponse.json(result, { status: httpStatus });
}
