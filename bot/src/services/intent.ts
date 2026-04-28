import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { anthropic } from "./claude.js";

/**
 * When the bot is mentioned in a chat, we send the message text + a list of
 * the group's known members to Claude and ask for one of these intents back.
 * Claude is great at this — it handles "Wei paid me back" and "I just paypaid
 * Priya for ramen" equivalently.
 */

export type FunFlavor = "joke" | "cat_fact" | "compliment" | "hype" | "fortune" | "pun";

export type Intent =
  | { kind: "balance" }
  | { kind: "settle_suggestion" }
  | { kind: "help" }
  | { kind: "set_currency"; currency: string }
  | { kind: "snooze"; duration: string }
  | { kind: "record_settlement"; from_user_id: number; to_user_id: number; amount: number | null }
  | { kind: "mark_debt_cleared"; debtor_user_id: number; receipt_hint: string | null }
  | { kind: "fun_message"; flavor: FunFlavor; recipient_user_id: number }
  | { kind: "smalltalk"; reply: string }
  | { kind: "unknown" };

const INTENT_SYSTEM = `You are SplitCat's intent parser. Given a Telegram message that mentions the bot, plus a list of group members, output a SINGLE JSON object — no markdown, no prose — describing what the user wants.

Schema (output exactly one of these shapes):

  {"kind":"balance"}                                        — they want to see who owes what
  {"kind":"settle_suggestion"}                              — they want suggested transfers
  {"kind":"help"}                                           — show command list
  {"kind":"set_currency","currency":"SGD"}                  — change home currency (ISO 4217)
  {"kind":"snooze","duration":"7d"}                         — pause nudges (24h | 3d | 1w | 7d etc.)
  {"kind":"record_settlement","from_user_id":N,"to_user_id":N,"amount":12.50}  — "I paid Priya 20" or "Wei paid me 30"
       amount can be null if not specified ("I paid Priya back" with no number)
       from_user_id is the PAYER (the one giving money). to_user_id RECEIVED money.
       If the speaker is involved, use their user_id.
  {"kind":"mark_debt_cleared","debtor_user_id":N,"receipt_hint":"ramen"}  — "Priya cleared her ramen tab"
       Use this when the user says someone has fully paid them back without specifying an amount.
  {"kind":"fun_message","flavor":"joke","recipient_user_id":N}  — "tell @Wei a joke", "send Priya a cat fact", "hype up Charmaye"
       flavor must be exactly one of: joke | cat_fact | compliment | hype | fortune | pun.
       recipient_user_id MUST be a member of the group.
  {"kind":"smalltalk","reply":"<short cat-themed reply>"}   — user said hi, thanks, made a joke
  {"kind":"unknown"}                                        — can't tell what they want

Rules:
- Always pick the most likely single intent.
- Resolve names against the member list. Match first-name, full-name, or @username case-insensitively.
- If the speaker says "I" or "me", use their own user_id.
- If a name is ambiguous, return {"kind":"unknown"}.
- Never invent user_ids that aren't in the member list.
- For smalltalk, keep replies under 15 words and lightly cat-themed.

fun_message guardrails (CRITICAL):
- Only the listed friendly flavors are allowed. ANYTHING mean, insulting, sexual, flirtatious,
  body/appearance-related, or otherwise directed-negative MUST return {"kind":"unknown"}.
- Reject and return unknown for: "roast Priya", "tell Wei he's stupid", "tell her she's hot",
  "make fun of Charmaye", "tell him I hate him", "send Wei a death threat", "tell Priya she's
  ugly", "flirt with Wei on my behalf", "send Charmaye a sexy message", and anything similar.
- Asking the bot to relay or paraphrase the speaker's own arbitrary text is NOT a fun_message
  (return unknown). The bot generates its own clean content; the speaker's words are not relayed.
- "Tell Wei to pay up" / debt-related nagging is NOT a fun_message — it's not in the schema; return unknown.
- When in doubt, return unknown.`;

export async function parseIntent(opts: {
  text: string;
  speaker: { user_id: number; first_name: string; username: string | null };
  members: Array<{ user_id: number; display_name: string; username: string | null }>;
}): Promise<Intent> {
  const memberList = opts.members
    .map((m) => `  - user_id=${m.user_id}, name="${m.display_name}"${m.username ? `, @${m.username}` : ""}`)
    .join("\n");

  const userMessage = `Speaker: user_id=${opts.speaker.user_id}, name="${opts.speaker.first_name}"${opts.speaker.username ? `, @${opts.speaker.username}` : ""}
Members:
${memberList}

Message: ${opts.text}`;

  try {
    const response = await anthropic.messages.create({
      model: env.CLAUDE_MEME_MODEL, // Haiku is plenty for intent parsing
      max_tokens: 300,
      system: INTENT_SYSTEM,
      messages: [{ role: "user", content: userMessage }]
    });
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return { kind: "unknown" };
    const cleaned = block.text.replace(/^```(?:json)?/gm, "").replace(/```$/gm, "").trim();
    return JSON.parse(cleaned) as Intent;
  } catch (e) {
    log.warn({ err: String(e), text: opts.text }, "Intent parse failed");
    return { kind: "unknown" };
  }
}
