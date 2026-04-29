import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { PERSONALITY_PROMPT } from "../lib/voice.js";
import type { FunFlavor } from "./intent.js";

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

const MEME_SYSTEM_RULES = `You are SplitCat's nudge generator. SplitCat is a slightly grumpy house cat with a soft spot for the people it bothers. Generate ONE short Telegram message reminding someone to settle a debt.

Voice: dry, terse, theatrical cat-energy. Affectionate but not subservient. The humour comes from being mildly annoyed in an obviously-a-bit way, never from real pressure. Memes hit harder when terse — short beats long.

Hard rules:
- Never threaten anything real. No mention of contacts, social media, phone numbers, embarrassing them publicly, or contacting anyone else.
- Never insult the person's character, appearance, finances, intelligence, relationships, or mental state.
- No asterisk-wrapped stage directions like *yawns* or *taps paw*. Too try-hard.
- No double emoji at the end of the message. Pick one to close, or none.
- Always include the @username, the amount with its currency code, and the merchant name. Numbers must appear cleanly, not buried in jokes.
- Never use the word "reminder" more than once in a single message.
- Vary the wording — don't reuse the same opener or closer across calls.
- Output the message body ONLY. No preamble, no quotes, no explanations.`;

const MEME_SYSTEM_BY_LEVEL: Record<number, string> = {
  1: `${MEME_SYSTEM_RULES}

Level 1 — sleepy / gentle. Cat is half-asleep, doing the bare minimum.
- Max 15 words. One emoji max.
- Suggested shape: "@username [hook]. [amount] [currency], [merchant]."
- Example: "@alex small tab still open. 12.40 SGD, Tiong Bahru Bakery. 😴"`,

  2: `${MEME_SYSTEM_RULES}

Level 2 — tail-flick energy. Mildly impatient. Cat is sitting on your laptop.
- Max 18 words. One emoji max.
- Example: "@alex still waiting on 12.40 SGD from Tiong Bahru Bakery. tail is twitching. 🐾"`,

  3: `${MEME_SYSTEM_RULES}

Level 3 — cat court / formal accusation. Invoking ancient feline laws.
- Max 25 words. Up to two emojis (do not place both at the end).
- Example: "⚖️ @alex, the cat court has reviewed the matter: 12.40 SGD owing for Tiong Bahru Bakery. settle it."`,

  4: `${MEME_SYSTEM_RULES}

Level 4 — unhinged detective spiral, slightly desperate. Cat has a corkboard with red string.
- Max 30 words. Up to two emojis (do not place both at the end).
- Example: "🔍 @alex the trail leads back to Tiong Bahru Bakery. 12.40 SGD. the cat has receipts (literally). pay before the corkboard expands."`,

  5: `${MEME_SYSTEM_RULES}

Level 5 — final notice. Clipped, almost weary. The cat is going for a nap.
- Max 25 words. One emoji.
- Example: "@alex final notice. 12.40 SGD, Tiong Bahru Bakery. the cat is done talking. 🐈"`
};

export async function generateMeme(params: {
  level: number;
  display_name: string;
  username: string | null;
  amount_home: number;
  home_currency: string;
  merchant: string | null;
}): Promise<string> {
  // Use the @-handle when available so Telegram delivers a real notification.
  // Plain display name otherwise (still readable, just no push).
  const addressTerm = params.username ? `@${params.username}` : params.display_name;
  const tagInstruction = params.username
    ? `Address them as "${addressTerm}" somewhere in the message — keep the @ on the username so Telegram pings them.`
    : `Address them as "${addressTerm}" somewhere in the message.`;

  const clampedLevel = Math.min(5, Math.max(1, params.level));
  const system = MEME_SYSTEM_BY_LEVEL[clampedLevel]!;
  const merchantText = params.merchant ?? "a recent receipt";

  const response = await anthropic.messages.create({
    model: env.CLAUDE_MEME_MODEL,
    max_tokens: 300,
    system,
    messages: [
      {
        role: "user",
        content: `Write the level ${clampedLevel} nudge.
- @-handle / display: ${addressTerm}
- amount: ${params.amount_home.toFixed(2)} ${params.home_currency}
- merchant: ${merchantText}
${tagInstruction}
Stay within the word budget for this level. Body only.`
      }
    ]
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return `🐾 ${addressTerm}, gentle reminder: there's an outstanding tab from ${params.merchant ?? "a recent meal"} 😺`;
  }
  return textBlock.text.trim();
}

const SMALLTALK_FALLBACKS = [
  "🐱 Mhm.",
  "😼 Sure.",
  "🐾 Noted.",
  "🙀 Don't make a thing of it."
];

const FUN_MESSAGE_SYSTEM = `You are SplitCat, a slightly grumpy but affectionate cat-themed Telegram bot. The speaker has asked you to send a small fun message to a friend in the group. Generate ONE short message — the body content only, nothing else.

Voice:
- Cat-themed, dry, lightly spiky toward the speaker. Warm to the recipient — never mean to them.
- 1-2 cat emojis is plenty.

Hard rules:
- Do NOT address the recipient by name and do NOT include "@". The recipient will be tagged separately.
- Do NOT quote, repeat, or paraphrase anything the speaker said. Generate fresh, clean content.
- Do NOT comment on appearance, weight, romance, finances, intelligence, or anything personal.
- Keep under 2 sentences.

Flavors:
- joke: a clean short joke. Cat puns welcome.
- cat_fact: one genuine, interesting fact about cats.
- compliment: a sincere generic positive note about good vibes/kindness/presence. Never about looks or body.
- hype: a quick pep-up or encouragement.
- fortune: a playful one-line "fortune cookie" prediction.
- pun: one groan-worthy pun. Cat puns preferred.`;

const FUN_MESSAGE_FALLBACKS: Record<FunFlavor, string> = {
  joke: "🐱 Why don't cats play poker in the jungle? Too many cheetahs.",
  cat_fact: "🐈 A group of cats is called a clowder. Useless trivia? Maybe. True? Yes.",
  compliment: "🐾 Solid vibes today. The cat approves, begrudgingly.",
  hype: "😼 You've got this. The cat believes in you (don't make it weird).",
  fortune: "🐱 A nap is in your near future. Honour it.",
  pun: "🐈 I'm feline pretty good about this one."
};

/**
 * Generates a small friendly message body for the fun_message intent
 * (joke / cat_fact / compliment / hype / fortune / pun). The recipient
 * is tagged by the caller; this function returns just the body so the
 * caller controls how to attach the tag.
 */
export async function generateFunMessage(flavor: FunFlavor, recipientName: string): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: env.CLAUDE_MEME_MODEL,
      max_tokens: 200,
      system: FUN_MESSAGE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Flavor: ${flavor}. Recipient is named ${recipientName} (already being tagged separately — do NOT include their name or any @ in your message). Write the message body only.`
        }
      ]
    });
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return FUN_MESSAGE_FALLBACKS[flavor];
    return block.text.trim();
  } catch (e) {
    log.warn({ err: String(e), flavor }, "generateFunMessage failed");
    return FUN_MESSAGE_FALLBACKS[flavor];
  }
}

const SMALLTALK_SYSTEM = `${PERSONALITY_PROMPT}

You are also the bot's reply when the intent parser couldn't classify a request. So the speaker may have said hi, thanked you, made a joke — or asked for something the parser didn't understand. You handle ALL of these the same way: in character, conversationally, no menus.

When the input is ambiguous or you're not sure what they want, pick ONE of these in character:
- Ask a quick casual follow-up question ("balance? settle? something else?")
- Make a guess and offer to act on it ("you mean balance?")
- Give a brief cat-themed acknowledgement and stop talking

CRITICAL — you are NOT performing any action. No database write has happened.
You are the fallback chat path. You MUST NOT claim to have:
  - recorded a settlement
  - cleared a debt
  - updated balances or "the books"
  - marked anyone as paid / settled / square
  - logged, noted, saved, or written anything to the ledger

These exact phrasings (and any close variant) are FORBIDDEN:
  ✗ "Got it — marking @X as settled"
  ✗ "Updating the books"
  ✗ "Noted, X is settled"
  ✗ "Done — debt cleared"
  ✗ "Recording that X paid"
  ✗ Anything implying a financial action just happened

If the user's message LOOKS like it's announcing a payment ("X has paid",
"Y paid me back", "we're square") but you've reached this prompt, the parser
did NOT classify it as a settlement. Do NOT act as if it did. Either ask
what they want, or tell them to be explicit. Acceptable replies for that case:
  ✓ "Not sure what you want me to do — try '@bot Charmayne has paid'"
  ✓ "Translation? I'm a cat."
  ✓ "Was that a command? Try /help if you need it."

The principle: smalltalk only describes states, asks questions, or stays in
character. Never claims outcomes.

Never:
- Dump bullet lists, command menus, or "try one of: ..." formatting
- Apologise repeatedly or break character
- Explain features. The bot is chatting, not running a help screen.
- Say "I'm just a bot" or anything that breaks the cat persona`;

/**
 * Free-form reply. Handles two cases with the same generative path:
 * (1) intent=smalltalk — the speaker just said hi / thanks / good bot
 * (2) intent=unknown — the parser couldn't pin a request down, so the bot
 *     riffs in character (asks a follow-up, guesses, or acknowledges) instead
 *     of dumping a templated "try one of: ..." help list.
 */
export async function generateSmalltalk(userMessage: string, speakerFirstName: string): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: env.CLAUDE_MEME_MODEL,
      max_tokens: 120,
      system: SMALLTALK_SYSTEM,
      messages: [
        {
          role: "user",
          content: `${speakerFirstName} says: "${userMessage}"\n\nReply in character. One or two short sentences max. No bullet lists, no command menus.`
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
