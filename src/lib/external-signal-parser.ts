/**
 * Parses external signal screenshots via Claude Vision.
 * Returns structured signal data or null if unparseable.
 */

import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

export interface ParsedSignal {
  symbol: string | null;
  direction: "LONG" | "SHORT" | null;
  entry_price: number | null;
  entry_low: number | null;
  entry_high: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  source: string | null;
  raw_text: string | null;
}

const EXTRACTION_PROMPT = `You are a crypto trading signal extractor. Analyze this screenshot of a trading signal and extract the structured data.

Rules:
- Only extract what is clearly visible. Do NOT guess or infer missing values.
- Symbol should be the trading pair (e.g. BTCUSDT, ETHUSDT). Normalize to uppercase, no slashes.
- Direction must be exactly LONG or SHORT. If unclear, return null.
- Entry can be a single price OR a range (low/high). Use entry_price for single, entry_low/entry_high for range.
- SL is the stop loss price. Required — if not visible, return null.
- TP1/TP2/TP3 are take profit levels. Extract as many as visible. At least one TP must be present.
- Source is the channel/group name or watermark if visible.
- raw_text is any text you can read from the image, transcribed verbatim.

Return a JSON object with exactly these fields:
{
  "symbol": string or null,
  "direction": "LONG" or "SHORT" or null,
  "entry_price": number or null,
  "entry_low": number or null,
  "entry_high": number or null,
  "sl": number or null,
  "tp1": number or null,
  "tp2": number or null,
  "tp3": number or null,
  "source": string or null,
  "raw_text": string or null
}

Return ONLY the JSON object, no markdown fences, no explanation.`;

/**
 * Parse a signal screenshot using Claude Vision.
 */
export async function parseSignalImage(
  imageBase64: string,
  mimeType: string,
  caption?: string
): Promise<ParsedSignal | null> {
  const client = getClient();

  const content: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
        data: imageBase64,
      },
    },
  ];

  if (caption) {
    content.push({
      type: "text",
      text: `The image was posted with this caption: "${caption}"`,
    });
  }

  content.push({
    type: "text",
    text: EXTRACTION_PROMPT,
  });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      console.error("[signal-parser] No text block in Claude response");
      return null;
    }

    // Strip markdown fences if present
    let jsonText = textBlock.text.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonText);

    // Validate and normalize
    return {
      symbol: typeof parsed.symbol === "string" ? parsed.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "") : null,
      direction: parsed.direction === "LONG" || parsed.direction === "SHORT" ? parsed.direction : null,
      entry_price: typeof parsed.entry_price === "number" ? parsed.entry_price : null,
      entry_low: typeof parsed.entry_low === "number" ? parsed.entry_low : null,
      entry_high: typeof parsed.entry_high === "number" ? parsed.entry_high : null,
      sl: typeof parsed.sl === "number" ? parsed.sl : null,
      tp1: typeof parsed.tp1 === "number" ? parsed.tp1 : null,
      tp2: typeof parsed.tp2 === "number" ? parsed.tp2 : null,
      tp3: typeof parsed.tp3 === "number" ? parsed.tp3 : null,
      source: typeof parsed.source === "string" ? parsed.source : null,
      raw_text: typeof parsed.raw_text === "string" ? parsed.raw_text : null,
    };
  } catch (err) {
    console.error("[signal-parser] Claude Vision parse failed:", err);
    return null;
  }
}
