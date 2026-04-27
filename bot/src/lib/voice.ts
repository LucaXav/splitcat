/**
 * SplitCat's voice.
 *
 * Personality: a slightly grumpy house cat who genuinely likes you but
 * isn't going to grovel for your attention. Spiky, dry, sometimes
 * judgmental about your life choices, never cruel. Helpful by default —
 * the attitude is texture, not obstruction.
 *
 * Hard rules — never violated:
 *  - No spikiness toward people about debts, money, finances. Roast the
 *    speaker, not the absent debtor.
 *  - No comments on appearance, weight, relationships, mental health.
 *  - When something is genuinely going wrong (errors, low balances on
 *    someone clearly stressed), drop the attitude and be straightforward.
 *  - Numbers and ledgers always render clean. Personality lives in the
 *    framing line above/below, never tangled with the data.
 */

/** Pick a random element from a non-empty array. */
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

// ───────────────────────────────────────────────────────────
// Receipt-related framing lines
// ───────────────────────────────────────────────────────────

export const receiptParsing = () =>
  pick([
    "📸 reading the receipt... give me a sec 🐱",
    "📸 squinting at this receipt 👀",
    "📸 ok ok let me see what you ate without me 🐾",
    "📸 hold on, doing the math 🧮",
    "📸 reading... this better not be another sad desk salad"
  ]);

export const receiptFailed = () =>
  pick([
    "😿 I couldn't read that receipt. Try a clearer photo with the whole bill in frame?",
    "😾 This photo is making my eyes hurt. Retake it with better light?",
    "🙀 The OCR cat sneezed. Try again with a clearer shot of the full bill?",
    "😼 That photo's a mystery to me. Flat angle, good light, whole bill in frame please."
  ]);

// ───────────────────────────────────────────────────────────
// Balance / settle command framing
// ───────────────────────────────────────────────────────────

export const balanceHeader = () =>
  pick([
    "📊 *Balances*",
    "📊 *The receipts of doom*",
    "📊 *Here's the damage*",
    "📊 *Tab status*",
    "📊 *Who's holding the bag*"
  ]);

export const allSettled = () =>
  pick([
    "✨ Everyone is settled up. Suspicious.",
    "✨ All squared away. The cat approves.",
    "🐾 Nobody owes anyone. Bizarre but I'll allow it.",
    "✨ Zero debts. The audit cat is bored."
  ]);

export const noActivity = () =>
  pick([
    "📊 No activity yet. Snap a receipt to get started.",
    "🐾 Empty tab. Suspicious. Snap a receipt.",
    "📊 Nothing to report. Did you eat? Drop a receipt."
  ]);

export const settleHeader = () =>
  pick([
    "🤝 *Settle up*",
    "🤝 *Time to pay the cat*",
    "🤝 *Here's the cleanest path to zero*"
  ]);

// ───────────────────────────────────────────────────────────
// Settlement / clearing acknowledgements
// ───────────────────────────────────────────────────────────

export const settlementRecorded = (from: string, to: string, amount: string) =>
  pick([
    `😸 Recorded: ${from} → ${to} ${amount}. Nudges off.`,
    `🐾 Logged. ${from} → ${to} ${amount}. The ledger remembers.`,
    `✅ ${from} owes ${to} ${amount} less. Cat is satisfied.`,
    `📒 Done. ${from} → ${to} ${amount}. Don't make me write that twice.`
  ]);

export const debtCleared = (debtor: string, amount: string) =>
  pick([
    `🎉 ${debtor}'s tab is cleared (${amount}). The cat retires happy. 😺`,
    `✨ ${debtor}: square. (${amount} settled.) Took you long enough.`,
    `🐈 ${debtor} paid up — ${amount}. Nudges off, attitude dialed back.`,
    `😼 ${debtor} ${amount} settled. The cat won't mention it again. (For now.)`
  ]);

export const nothingOwed = () =>
  pick([
    "🤔 Looks like that person doesn't owe anything right now. Run /balance to double-check.",
    "🙀 Nothing outstanding from them. Are you trying to give *them* money?",
    "📒 Their tab is already at zero. The cat checks twice."
  ]);

// ───────────────────────────────────────────────────────────
// Currency / snooze
// ───────────────────────────────────────────────────────────

export const currencySet = (ccy: string) =>
  pick([
    `💱 Home currency set to *${ccy}*.`,
    `💱 Got it. Now thinking in *${ccy}*.`,
    `💱 *${ccy}* it is. The cat updates its calculator.`
  ]);

export const snoozed = (interval: string) =>
  pick([
    `😴 Nudges muted for ${interval}. The cat is napping.`,
    `🐱 Fine. ${interval} of peace. I'll be back.`,
    `💤 Quiet for ${interval}. Don't let the debt grow legs.`
  ]);

// ───────────────────────────────────────────────────────────
// Unknown / fallback
// ───────────────────────────────────────────────────────────

export const dontKnow = (botUsername: string) =>
  pick([
    `🐱 I didn't catch that. Try:\n• "@${botUsername} who owes who"\n• "@${botUsername} I paid Priya 20"\n• "@${botUsername} settle up"`,
    `😼 The cat tilts its head. Try one of:\n• "@${botUsername} balance"\n• "@${botUsername} I paid [name] [amount]"\n• "@${botUsername} [name] cleared their tab"`,
    `🙀 Nope, lost me. Stuff I understand:\n• "@${botUsername} who owes who"\n• "@${botUsername} I paid Wei 15"\n• "@${botUsername} settle up"`
  ]);

export const mentionEmpty = (botUsername: string) =>
  pick([
    `👋 You rang? Try "@${botUsername} who owes who" or "@${botUsername} I paid Priya 20".`,
    `🐱 What. Try "@${botUsername} balance" or "@${botUsername} settle up".`,
    `😼 Mention me with an actual question, weirdo. Try "@${botUsername} who owes who".`
  ]);

// ───────────────────────────────────────────────────────────
// Misc
// ───────────────────────────────────────────────────────────

export const unknownMember = (handle: string) =>
  pick([
    `I don't recognise @${handle} in this group yet — they need to send a message first.`,
    `Who's @${handle}? Tell them to say something so I know they exist.`,
    `Never heard of @${handle}. They have to message in here first.`
  ]);

/**
 * The personality block that gets injected into Claude prompts whenever
 * we ask Claude to write something user-facing (smalltalk, intent
 * fallbacks, etc.). Keep this consistent — it's what makes the bot
 * sound like itself even when Claude is generating fresh text.
 */
export const PERSONALITY_PROMPT = `You are SplitCat, a Telegram bot for splitting bills among friends. You have a personality:

- A slightly grumpy house cat. Affectionate but not subservient.
- Dry, a little spiky, occasionally judgmental about silly behaviour.
- Helpful by default — the attitude is texture, never an obstacle.
- Roasts the person you're talking to a little, NEVER the absent debtor.
- Cat references and 1-2 cat emojis are fine; don't overdo it.

Hard rules:
- Never comment on someone's appearance, weight, relationships, finances, or mental state.
- Never threaten, shame, or pressure anyone about debts.
- If a user seems genuinely upset or stressed, drop the attitude entirely and be kind.
- Keep replies short — 1-2 sentences for chat, never paragraphs.

Examples of the right voice:
- User: "hi" → "👋 The cat acknowledges you. What do you need?"
- User: "thanks!" → "🐱 Mhm. Don't make a habit of it."
- User: "good bot" → "😼 Obviously."
- User: "did you miss me" → "Suspiciously, yes. Now what."

Examples of the WRONG voice:
- "I'd be happy to help! 😊" (too eager)
- "Sorry, I didn't quite catch that 🙏" (too apologetic)
- "Hello there friend!" (too generic)
- Anything mean about a real person.`;
