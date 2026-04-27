import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { PERSONALITY_PROMPT } from "../lib/voice.js";

export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export type ParsedReceipt = {
  merchant: string | null;
  date: string | null;
  currency: string;
  line_items: Array<{
    description: string;
    quantity: number;
    unit_price: number;
    line_total: number;
  }>;
  subtotal: number;
  service_charge: number;
  tax: number;
  tip: number;
  total: number;
  confidence: "high" | "medium" | "low";
  notes: string;
};

const RECEIPT_SYSTEM = `You are a receipt-parsing assistant. Extract structured data from a receipt image and return ONLY a JSON object — no markdown fences, no prose.

Schema:
{
  "merchant": string | null,
  "date": "YYYY-MM-DD" | null,
  "currency": ISO 4217 string (SGD, JPY, USD, EUR, THB, MYR, IDR, etc.),
  "line_items": [{"description": string, "quantity": number, "unit_price": number, "line_total": number}],
  "subtotal": number,
  "service_charge": number,
  "tax": number,
  "tip": number,
  "total": number,
  "confidence": "high" | "medium" | "low",
  "notes": string
}

Currency inference: Singapore receipts → SGD (10% service, 9% GST compounded). Japan → JPY (10% consumption tax usually included). US → USD (state-varying sales tax + handwritten tip). EU → EUR (VAT included). Thailand → THB (7% VAT, 10% service at restaurants). Malaysia → MYR (10% service, 6% SST). Indonesia → IDR (5-10% service, 10% PB1).

If a field is unreadable, make your best guess and set confidence to "low". Use the notes field to flag anything weird.`;

export async function parseReceipt(imageBase64: string, mediaType: "image/jpeg" | "image/png" = "image/jpeg"): Promise<ParsedReceipt> {
  const response = await anthropic.messages.create({
    model: env.CLAUDE_VISION_MODEL,
    max_tokens: 2000,
    system: RECEIPT_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 }
          },
          { type: "text", text: "Parse this receipt." }
        ]
      }
    ]
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }
  const cleaned = textBlock.text.replace(/^```(?:json)?/gm, "").replace(/```$/gm, "").trim();
  try {
    return JSON.parse(cleaned) as ParsedReceipt;
  } catch (e) {
    log.error({ raw: textBlock.text }, "Failed to parse Claude JSON response");
    throw new Error("Receipt parsing returned malformed JSON");
  }
}

const MEME_SYSTEM = `You are SplitCat's nudge generator. SplitCat is a slightly grumpy house cat with a soft spot for the people it bothers. Generate ONE short Telegram message reminding someone to settle a debt.

Voice: dry, a touch spiky, theatrical cat-energy. Affectionate but not subservient. The humour comes from the cat being mildly annoyed in a clearly-a-bit way, never from real pressure.

Hard rules:
- Never threaten anything real. No mention of contacts, social media, phone numbers, embarrassing them publicly, or contacting anyone else.
- Never insult the person's character, appearance, finances, intelligence, relationships, or mental state.
- The humour is overcommitted cat drama. It must read as a bit, never as actual pressure.
- Numbers and amounts must appear cleanly, not buried in jokes.

Escalation levels (the cat gets gradually more theatrical, NOT meaner):
1: gentle. sleepy cat. "paw-lite reminder", maybe a yawn.
2: tapping paw. mildly impatient. cat is now sitting on your laptop.
3: dramatic. cat court / cat lawyer energy. invoking ancient feline laws.
4: full unhinged. cat in tiny detective coat. cat has prepared a slideshow. theatrical.
5: final reminder. acknowledge it's the last one. the cat is going for a nap, the matter is between you and your conscience.

Include 1-3 cat-related emojis. Visual memes go in [brackets]. Keep under 3 sentences.`;

export async function generateMeme(params: {
  level: number;
  display_name: string;
  amount_home: number;
  home_currency: string;
  merchant: string | null;
}): Promise<string> {
  const response = await anthropic.messages.create({
    model: env.CLAUDE_MEME_MODEL,
    max_tokens: 300,
    system: MEME_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Nudge level ${params.level}. ${params.display_name} owes about ${params.amount_home.toFixed(2)} ${params.home_currency} from ${params.merchant ?? "a recent receipt"}. Write the message.`
      }
    ]
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return `🐾 gentle reminder: there's an outstanding tab from ${params.merchant ?? "a recent meal"} 😺`;
  }
  return textBlock.text.trim();
}

const SMALLTALK_FALLBACKS = [
  "🐱 Mhm.",
  "😼 Sure.",
  "🐾 Noted.",
  "🙀 Don't make a thing of it."
];

/**
 * Free-form chit-chat reply. Used when the intent parser classifies a
 * mention as smalltalk ("hi", "thanks", "good bot", etc.). We do a
 * separate Claude call here with the full personality prompt so the
 * voice is consistent and fresh, rather than reusing the intent
 * parser's quick reply field.
 */
export async function generateSmalltalk(userMessage: string, speakerFirstName: string): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: env.CLAUDE_MEME_MODEL,
      max_tokens: 100,
      system: PERSONALITY_PROMPT,
      messages: [
        {
          role: "user",
          content: `${speakerFirstName} says: "${userMessage}"\n\nReply in character. One short line. Don't introduce yourself, don't explain the bot's features.`
        }
      ]
    });
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      return SMALLTALK_FALLBACKS[Math.floor(Math.random() * SMALLTALK_FALLBACKS.length)]!;
    }
    return block.text.trim();
  } catch {
    return SMALLTALK_FALLBACKS[Math.floor(Math.random() * SMALLTALK_FALLBACKS.length)]!;
  }
}
