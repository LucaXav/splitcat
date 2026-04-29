import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import { log } from "../lib/log.js";
import { anthropic } from "./claude.js";

/**
 * When the bot is mentioned (or replied to) in a chat, we hand the message
 * text + the group's known members to Claude and ask for one of these
 * intents back. We use Claude's tool-use API so the response shape is
 * schema-validated by the API itself — no JSON parsing in the happy path.
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
  | { kind: "flattery"; reply: string }
  | { kind: "unknown" };

const INTENT_KINDS = [
  "balance",
  "settle_suggestion",
  "help",
  "set_currency",
  "snooze",
  "record_settlement",
  "mark_debt_cleared",
  "fun_message",
  "smalltalk",
  "flattery",
  "unknown"
] as const;

const FUN_FLAVORS: FunFlavor[] = ["joke", "cat_fact", "compliment", "hype", "fortune", "pun"];

const INTENT_SYSTEM = `You are SplitCat's intent parser. Given a Telegram message that mentions or replies to the bot, plus a list of group members, call the set_intent tool exactly once with the appropriate fields for the chosen kind.

Intent meanings:
- balance — user wants to see who owes who.
- settle_suggestion — user wants suggested transfers.
- help — show command list.
- set_currency — change home currency. Set "currency" to ISO 4217 (e.g. "SGD").
- snooze — pause nudges. Set "duration" to a string like "24h" / "3d" / "1w".
- record_settlement — a payment WITH an explicit amount.
    from_user_id is the PAYER (giving money). to_user_id RECEIVED money. If the
    speaker is involved, use their user_id. amount is null if unspecified.
    Examples that MUST classify as record_settlement:
      • "I paid Priya 20"            → from=speaker, to=Priya, amount=20
      • "Wei paid me 30"             → from=Wei, to=speaker, amount=30
      • "Charmayne paid me 20"       → from=Charmayne, to=speaker, amount=20
      • "I paid Wei 50"              → from=speaker, to=Wei, amount=50
      • "I sent Priya 12.50"         → from=speaker, to=Priya, amount=12.5
- mark_debt_cleared — a payment WITHOUT a specific amount; treat the debtor's
    full outstanding balance as settled. The speaker is implicitly the creditor.
    Examples that MUST classify as mark_debt_cleared:
      • "Charmayne has paid"         → debtor=Charmayne
      • "@charmayneyy has paid"      → debtor=Charmayne (resolve @-handle)
      • "Wei paid me back"           → debtor=Wei
      • "Charmayne settled up"       → debtor=Charmayne
      • "Charmayne is square"        → debtor=Charmayne
      • "Wei cleared his tab"        → debtor=Wei
      • "done with Wei"              → debtor=Wei (speaker means Wei has paid)
      • "Priya cleared her ramen tab"→ debtor=Priya, receipt_hint="ramen"
      • "she has paid" / "he has paid" → resolve from group context if a clear
        single candidate exists; otherwise unknown.
    When the message implies a person has paid the speaker but you're torn
    between unknown and mark_debt_cleared, PREFER mark_debt_cleared. False
    positives are recoverable (the user can undo); silent false negatives
    leave debts unsettled forever.
- fun_message — "tell @Wei a joke", "send Priya a cat fact", "hype up Charmaye".
    flavor must be exactly one of: joke | cat_fact | compliment | hype | fortune | pun.
    recipient_user_id MUST be a member of the group.
- smalltalk — user said hi, thanks, made a joke. "reply" should be a short
  cat-themed line under 15 words.
- flattery — the user is laying it on THICK with praise / love / fandom
  directed AT the bot. This must be RARE — the matching easter egg only
  works if it's surprising. Default to smalltalk when in any doubt.

  ONLY trigger flattery when one of these clearly applies:
    • Strong, deliberate praise: "very good boy", "such a good kitty",
      "best cat ever", "you're amazing", "splitcat is the goat"
    • Effusive thanks tied to praise: "thank you so much kitty",
      "thanks splitcat you're the best", "ty kitty so helpful"
    • Sustained / emphasized affection: multiple praise words, intensifiers
      ("really really good", "the absolute best"), or affectionate emojis
      paired with praise ("good cat 🥰", "the best 😻")
    • Direct love or fandom statements: "I love you splitcat", "splitcat
      is my favorite", "best bot in the universe", "marry me splitcat"

  These do NOT trigger flattery — return smalltalk instead:
    • Plain short praise: "good boy", "good cat", "nice job" — too low-key
    • Plain thanks: "thanks" / "ty" / "thank you" with no other content
    • Task acknowledgment: "thanks for the receipt", "good catch",
      "well done" tied to a specific action the bot did
    • Generic positivity: "good morning", "ok cool", "nice"

  Bar to clear: would a passing observer say "wow, they're really laying
  it on thick with the bot"? If yes → flattery. Otherwise → smalltalk.
  When in doubt, smalltalk. Rare and surprising is the goal.

  "reply" should be a short cat-themed line under 15 words — same shape as smalltalk.
- unknown — can't tell, or any guardrail below trips.

Rules:
- Pick the most likely single intent.
- Resolve names against the member list. Match first-name, full-name, or @username case-insensitively.
- If the speaker says "I" or "me", use their own user_id.
- If a name is ambiguous, use kind="unknown".
- Never invent user_ids that aren't in the member list.

fun_message guardrails (CRITICAL):
- Only the listed friendly flavors are allowed. ANYTHING mean, insulting, sexual, flirtatious,
  body/appearance-related, or otherwise directed-negative MUST set kind to "unknown".
- Reject and return unknown for: "roast Priya", "tell Wei he's stupid", "tell her she's hot",
  "make fun of Charmaye", "tell him I hate him", "send Wei a death threat", "tell Priya she's
  ugly", "flirt with Wei on my behalf", "send Charmaye a sexy message", and similar.
- Asking the bot to relay or paraphrase the speaker's own arbitrary text is NOT a fun_message
  (return unknown). The bot generates its own clean content.
- "Tell Wei to pay up" / debt nagging is NOT a fun_message — return unknown.
- When in doubt, return unknown.`;

const INTENT_TOOL: Anthropic.Messages.Tool = {
  name: "set_intent",
  description:
    "Record the parsed user intent. Provide exactly the fields appropriate to the chosen kind; omit the rest.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...INTENT_KINDS] },
      currency: { type: "string", description: "ISO 4217 code. Required when kind=set_currency." },
      duration: {
        type: "string",
        description: "Snooze duration like '24h', '3d', '1w'. Required when kind=snooze."
      },
      from_user_id: {
        type: "number",
        description:
          "Payer's user_id. Required when kind=record_settlement. The PAYER is the one giving money. Example: 'Charmayne paid me 20' → from=Charmayne; 'I paid Wei 50' → from=speaker."
      },
      to_user_id: {
        type: "number",
        description:
          "Receiver's user_id. Required when kind=record_settlement. Example: 'Charmayne paid me 20' → to=speaker; 'I paid Wei 50' → to=Wei."
      },
      amount: {
        type: ["number", "null"],
        description: "Settlement amount in the receipt currency; null if unspecified."
      },
      debtor_user_id: {
        type: "number",
        description:
          "The person who has paid back the speaker. Required when kind=mark_debt_cleared. Use this for phrasings like 'Charmayne has paid', '@charmayneyy has paid', 'Wei paid me back', 'Charmayne settled up', 'Wei cleared his tab', 'done with Wei', 'she/he has paid'. When ambiguous between unknown and mark_debt_cleared, prefer mark_debt_cleared."
      },
      receipt_hint: {
        type: ["string", "null"],
        description: "Free-text hint about which receipt; null if not given."
      },
      flavor: {
        type: "string",
        enum: [...FUN_FLAVORS],
        description: "Required when kind=fun_message."
      },
      recipient_user_id: { type: "number", description: "Required when kind=fun_message." },
      reply: {
        type: "string",
        description:
          "Short cat-themed reply (<15 words). Required when kind=smalltalk or kind=flattery."
      }
    },
    required: ["kind"]
  } as Anthropic.Messages.Tool["input_schema"]
};

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
      max_tokens: 400,
      system: INTENT_SYSTEM,
      tools: [INTENT_TOOL],
      tool_choice: { type: "tool", name: "set_intent" },
      messages: [{ role: "user", content: userMessage }]
    });

    // Happy path: Claude calls the tool. The API has already validated the
    // input against our schema, so no JSON parsing is needed.
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (toolBlock && toolBlock.type === "tool_use" && toolBlock.name === "set_intent") {
      return validateIntent(toolBlock.input);
    }

    // Defensive fallback: if the model somehow returns plain text (e.g. an
    // upstream error surfaces an assistant message instead of a tool call),
    // pull out the first balanced JSON object and parse that.
    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      const jsonStr = extractFirstJsonObject(textBlock.text);
      if (jsonStr) {
        try {
          return validateIntent(JSON.parse(jsonStr));
        } catch (e) {
          log.warn({ err: String(e), raw: textBlock.text }, "Intent fallback JSON parse failed");
        }
      } else {
        log.warn({ raw: textBlock.text }, "Intent response had no JSON to extract");
      }
    }
    return { kind: "unknown" };
  } catch (e) {
    log.warn({ err: String(e), text: opts.text }, "Intent parse failed");
    return { kind: "unknown" };
  }
}

function validateIntent(input: unknown): Intent {
  if (!input || typeof input !== "object") return { kind: "unknown" };
  const obj = input as Record<string, unknown>;
  const kind = typeof obj.kind === "string" ? obj.kind : null;
  if (!kind || !(INTENT_KINDS as readonly string[]).includes(kind)) {
    return { kind: "unknown" };
  }
  // The tool-use schema validates field shapes for the happy path. For the
  // text fallback we only assert the discriminator; the rest is best-effort.
  return obj as unknown as Intent;
}

/**
 * Extract the first balanced top-level JSON object from a string. Handles
 * brace nesting and string literals (so a `}` inside a string doesn't close
 * the object). Returns the substring containing just the {...} block, or
 * null if no balanced object is found.
 */
function extractFirstJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.substring(start, i + 1);
      }
    }
  }
  return null;
}
