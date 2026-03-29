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
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided =
      request.headers.get("x-webhook-secret") ??
      request.nextUrl.searchParams.get("secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let payload: Record<string, unknown>;

  try {
    // Read raw body text first — TradingView may send text/plain
    const rawBody = await request.text();
    let parsed: unknown = JSON.parse(rawBody);

    // TradingView wraps in {"text": "..."} — unwrap if needed
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "text" in parsed &&
      typeof (parsed as Record<string, unknown>).text === "string"
    ) {
      parsed = JSON.parse((parsed as Record<string, unknown>).text as string);
    }

    // TradingView may double-encode as a JSON string
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json(
        { error: "Payload must be a JSON object", received_type: typeof parsed },
        { status: 400 }
      );
    }

    payload = parsed as Record<string, unknown>;
  } catch (err) {
    const body = await request.text().catch(() => "(unreadable)");
    console.error("[alert] JSON parse error:", err, "body:", body.slice(0, 500));
    return NextResponse.json(
      { error: "Invalid JSON body", hint: "Body must be valid JSON" },
      { status: 400 }
    );
  }

  const missing = REQUIRED_FIELDS.filter((f) => !(f in payload));
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Missing required fields: ${missing.join(", ")}`,
        received_fields: Object.keys(payload),
        hint: "Required: type, symbol, tf, price, rsi, adx1h, adx4h, bb_width",
      },
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
