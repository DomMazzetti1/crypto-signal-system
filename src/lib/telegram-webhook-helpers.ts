/**
 * Telegram Bot API helpers for the webhook ingestion layer.
 * Separate from the existing telegram.ts (which handles outbound trade signals).
 */

function getToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  return token;
}

/**
 * Download a file from Telegram by file_id.
 * Returns the raw bytes as a Buffer and the MIME type.
 */
export async function downloadPhoto(
  fileId: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const token = getToken();

  // Step 1: get file path from Telegram
  const fileRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
  );
  if (!fileRes.ok) {
    console.error(`[tg-webhook] getFile failed (${fileRes.status})`);
    return null;
  }
  const fileData = await fileRes.json();
  const filePath = fileData?.result?.file_path;
  if (!filePath) {
    console.error("[tg-webhook] getFile returned no file_path");
    return null;
  }

  // Step 2: download the actual file
  const downloadRes = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`
  );
  if (!downloadRes.ok) {
    console.error(`[tg-webhook] file download failed (${downloadRes.status})`);
    return null;
  }

  const arrayBuf = await downloadRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  // Derive MIME from extension
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  const mimeType = mimeMap[ext] ?? "image/jpeg";

  return { buffer, mimeType };
}

/**
 * Send a text message to a Telegram chat.
 */
export async function sendMessage(
  chatId: string | number,
  text: string,
  replyToMessageId?: number
): Promise<boolean> {
  const token = getToken();
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`[tg-webhook] sendMessage failed (${res.status}): ${body}`);
    return false;
  }
  return true;
}
