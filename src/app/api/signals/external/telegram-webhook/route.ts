import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { downloadPhoto, sendMessage } from "@/lib/telegram-webhook-helpers";
import { parseSignalImage, ParsedSignal } from "@/lib/external-signal-parser";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Always return 200 to Telegram — errors are logged, not surfaced.
const OK = NextResponse.json({ ok: true });

// ── Types for Telegram webhook payload ─────────────────────

interface TelegramPhoto {
  file_id: string;
  width: number;
  height: number;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhoto[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ── Main handler ───────────────────────────────────────────

export async function POST(request: NextRequest) {
  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    console.error("[tg-webhook] Failed to parse request body");
    return OK;
  }

  const message = update.message;
  if (!message) return OK;

  const chatId = String(message.chat.id);

  // ── Validate sender ────────────────────────────────────
  const allowedRaw = process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "";
  const allowed = allowedRaw
    .split(",")
    .map((s) => s.trim().replace(/\\n/g, ""))
    .filter(Boolean);

  if (!allowed.includes(chatId)) {
    console.warn(`[tg-webhook] Rejected chat_id=${chatId} (not in allowed list)`);
    return OK;
  }

  // ── Route: photo → parse signal ────────────────────────
  if (message.photo && message.photo.length > 0) {
    await handlePhoto(message, chatId);
    return OK;
  }

  // ── Route: text command ────────────────────────────────
  if (message.text) {
    const cmd = message.text.trim().toUpperCase();
    if (cmd === "CONFIRM") {
      await handleConfirm(chatId, message.message_id);
    } else if (cmd === "CANCEL") {
      await handleCancel(chatId, message.message_id);
    }
    // Anything else: ignore silently
    return OK;
  }

  return OK;
}

// ── Photo handler ──────────────────────────────────────────

async function handlePhoto(message: TelegramMessage, chatId: string) {
  const photos = message.photo!;
  // Telegram sends multiple sizes — pick the largest
  const best = photos.reduce((a, b) =>
    a.width * a.height >= b.width * b.height ? a : b
  );

  console.log(`[tg-webhook] Photo received in chat=${chatId} file_id=${best.file_id}`);

  // Download the image
  const photo = await downloadPhoto(best.file_id);
  if (!photo) {
    await sendMessage(chatId, "Failed to download image. Please try again.");
    return;
  }

  // Parse via Claude Vision
  const imageBase64 = photo.buffer.toString("base64");
  const parsed = await parseSignalImage(imageBase64, photo.mimeType, message.caption);

  if (!parsed) {
    await sendMessage(chatId, "Could not extract signal from this image.", message.message_id);
    return;
  }

  // Validate minimum viable signal
  const issues = validateParsed(parsed);
  if (issues.length > 0) {
    await sendMessage(
      chatId,
      `Parsed image but missing required fields:\n${issues.join("\n")}`,
      message.message_id
    );
    return;
  }

  // Store in pending table
  const supabase = getSupabase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // +2 hours

  const { error: insertErr } = await supabase
    .from("external_signal_pending")
    .insert({
      telegram_chat_id: chatId,
      telegram_user_id: message.from?.id ? String(message.from.id) : null,
      telegram_message_id: String(message.message_id),
      telegram_received_at: new Date(message.date * 1000).toISOString(),
      source: parsed.source,
      raw_extracted_text: parsed.raw_text,
      parsed_payload: parsed,
      expires_at: expiresAt.toISOString(),
    });

  if (insertErr) {
    console.error("[tg-webhook] Failed to insert pending signal:", insertErr);
    await sendMessage(chatId, "Internal error storing signal. Please try again.");
    return;
  }

  // Reply with confirmation prompt
  const summary = formatSignalSummary(parsed);
  await sendMessage(chatId, summary, message.message_id);
}

// ── CONFIRM handler ────────────────────────────────────────

async function handleConfirm(chatId: string, messageId: number) {
  const supabase = getSupabase();

  // Find the latest PENDING row for this chat
  const { data: pending, error: fetchErr } = await supabase
    .from("external_signal_pending")
    .select("*")
    .eq("telegram_chat_id", chatId)
    .eq("status", "PENDING")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchErr) {
    console.error("[tg-webhook] Failed to fetch pending:", fetchErr);
    await sendMessage(chatId, "Internal error. Please try again.");
    return;
  }

  if (!pending) {
    await sendMessage(chatId, "No pending signal to confirm.", messageId);
    return;
  }

  // Check expiry
  if (new Date(pending.expires_at) < new Date()) {
    await supabase
      .from("external_signal_pending")
      .update({ status: "EXPIRED" })
      .eq("id", pending.id);
    await sendMessage(chatId, "Pending signal has expired (2h limit).", messageId);
    return;
  }

  const p = pending.parsed_payload as ParsedSignal;

  // Insert into external_signals
  const { data: signal, error: sigErr } = await supabase
    .from("external_signals")
    .insert({
      source: p.source ?? "unknown",
      raw_text: p.raw_text,
      symbol: p.symbol,
      direction: p.direction,
      entry_price: p.entry_price,
      entry_low: p.entry_low,
      entry_high: p.entry_high,
      sl: p.sl,
      tp1: p.tp1,
      tp2: p.tp2,
      tp3: p.tp3,
      posted_at: pending.telegram_received_at ?? pending.created_at,
      telegram_received_at: pending.telegram_received_at,
      source_message_id: pending.telegram_message_id,
      entry_fill_status: "PENDING",
      resolution_status: "PENDING_FILL",
    })
    .select("id")
    .single();

  if (sigErr) {
    console.error("[tg-webhook] Failed to insert external_signal:", sigErr);
    await sendMessage(chatId, `Failed to ingest signal: ${sigErr.message}`);
    return;
  }

  // Update pending row
  await supabase
    .from("external_signal_pending")
    .update({
      status: "CONFIRMED",
      confirmed_at: new Date().toISOString(),
      inserted_signal_id: signal.id,
    })
    .eq("id", pending.id);

  console.log(`[tg-webhook] Signal confirmed: ${signal.id} ${p.symbol} ${p.direction}`);
  await sendMessage(chatId, `Signal confirmed and ingested.\nID: ${signal.id}`, messageId);
}

// ── CANCEL handler ─────────────────────────────────────────

async function handleCancel(chatId: string, messageId: number) {
  const supabase = getSupabase();

  const { data: pending, error: fetchErr } = await supabase
    .from("external_signal_pending")
    .select("id")
    .eq("telegram_chat_id", chatId)
    .eq("status", "PENDING")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchErr) {
    console.error("[tg-webhook] Failed to fetch pending:", fetchErr);
    await sendMessage(chatId, "Internal error. Please try again.");
    return;
  }

  if (!pending) {
    await sendMessage(chatId, "No pending signal to cancel.", messageId);
    return;
  }

  await supabase
    .from("external_signal_pending")
    .update({
      status: "CANCELLED",
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", pending.id);

  await sendMessage(chatId, "Signal cancelled.", messageId);
}

// ── Helpers ────────────────────────────────────────────────

function validateParsed(p: ParsedSignal): string[] {
  const issues: string[] = [];
  if (!p.symbol) issues.push("- Symbol not detected");
  if (!p.direction) issues.push("- Direction (LONG/SHORT) not detected");
  if (!p.sl) issues.push("- Stop loss not detected");
  if (!p.tp1 && !p.tp2 && !p.tp3) issues.push("- No take profit levels detected");
  if (!p.entry_price && (!p.entry_low || !p.entry_high)) {
    issues.push("- No entry price or range detected");
  }
  return issues;
}

function formatSignalSummary(p: ParsedSignal): string {
  const entry =
    p.entry_price != null
      ? String(p.entry_price)
      : p.entry_low != null && p.entry_high != null
        ? `${p.entry_low} – ${p.entry_high}`
        : "unknown";

  const tps = [p.tp1, p.tp2, p.tp3].filter((t) => t != null);

  return [
    "Parsed signal candidate:",
    "",
    `Symbol: ${p.symbol ?? "unknown"}`,
    `Direction: ${p.direction ?? "unknown"}`,
    `Entry: ${entry}`,
    `SL: ${p.sl ?? "unknown"}`,
    `TPs: ${tps.length > 0 ? tps.join(", ") : "none"}`,
    p.source ? `Source: ${p.source}` : null,
    "",
    "Reply with:",
    "CONFIRM to ingest",
    "CANCEL to discard",
  ]
    .filter((line) => line !== null)
    .join("\n");
}
