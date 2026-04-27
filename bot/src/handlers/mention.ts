import type { Context } from "grammy";
import { db } from "../lib/db.js";
import { log } from "../lib/log.js";
import { parseIntent, type Intent } from "../services/intent.js";
import { generateSmalltalk } from "../services/claude.js";
import * as voice from "../lib/voice.js";
import {
  handleBalance,
  handleSettle,
  handleHelp,
  handleCurrency,
  handleSnooze
} from "./commands.js";

/**
 * Triggered when someone @-mentions the bot. The text after the mention is
 * sent to Claude for intent parsing, then dispatched to the appropriate
 * handler. Falls back to a friendly nudge if intent is unclear.
 */
export async function handleMention(ctx: Context): Promise<void> {
  if (!ctx.message?.text || !ctx.from || !ctx.chat) return;

  // Strip the @bot_username from the message so Claude sees just the request
  const me = await ctx.api.getMe();
  const mentionPattern = new RegExp(`@${me.username}\\b`, "gi");
  const cleanText = ctx.message.text.replace(mentionPattern, "").trim();

  if (!cleanText) {
    await ctx.reply(voice.mentionEmpty(me.username));
    return;
  }

  // Pull all known members in this group for Claude to disambiguate names
  const { rows: members } = await db.query<{
    user_id: string;
    display_name: string;
    username: string | null;
  }>(
    `SELECT user_id::text, display_name, username FROM members WHERE group_id = $1`,
    [ctx.chat.id]
  );

  const intent = await parseIntent({
    text: cleanText,
    speaker: {
      user_id: ctx.from.id,
      first_name: ctx.from.first_name ?? "",
      username: ctx.from.username ?? null
    },
    members: members.map((m) => ({
      user_id: Number(m.user_id),
      display_name: m.display_name,
      username: m.username
    }))
  });

  log.info({ intent: intent.kind, text: cleanText, user: ctx.from.id }, "mention intent");

  await dispatchIntent(ctx, intent);
}

async function dispatchIntent(ctx: Context, intent: Intent): Promise<void> {
  if (!ctx.chat || !ctx.from) return;

  switch (intent.kind) {
    case "balance":
      // Reuse the slash-command handler. It uses ctx.match for args; balance has none.
      await handleBalance(ctx as any);
      return;

    case "settle_suggestion":
      await handleSettle(ctx as any);
      return;

    case "help":
      await handleHelp(ctx as any);
      return;

    case "set_currency":
      // Inject ctx.match so handleCurrency can read it
      (ctx as any).match = intent.currency;
      await handleCurrency(ctx as any);
      return;

    case "snooze":
      (ctx as any).match = intent.duration;
      await handleSnooze(ctx as any);
      return;

    case "record_settlement":
      await recordSettlement(ctx, intent);
      return;

    case "mark_debt_cleared":
      await markDebtCleared(ctx, intent);
      return;

    case "smalltalk": {
      // Re-roll the reply with the personality prompt so it feels fresh,
      // rather than using whatever Haiku generated inside the intent JSON.
      const reply = await generateSmalltalk(ctx.message?.text ?? "", ctx.from.first_name ?? "you");
      await ctx.reply(reply);
      return;
    }

    case "unknown":
    default: {
      const me = await ctx.api.getMe();
      await ctx.reply(voice.dontKnow(me.username));
      return;
    }
  }
}

async function recordSettlement(
  ctx: Context,
  intent: Extract<Intent, { kind: "record_settlement" }>
): Promise<void> {
  if (!ctx.chat) return;

  // If amount is missing, just zero out the debt between these two users.
  if (intent.amount == null) {
    // Use the current outstanding balance from `from` to `to`
    const { rows } = await db.query<{ balance: string; home_currency: string }>(
      `SELECT
         (SELECT balance FROM member_balances WHERE group_id = $1 AND user_id = $2) AS balance,
         (SELECT home_currency FROM groups WHERE id = $1) AS home_currency`,
      [ctx.chat.id, intent.from_user_id]
    );
    const debtorBalance = Number(rows[0]?.balance ?? 0);
    if (debtorBalance >= 0) {
      await ctx.reply(voice.nothingOwed());
      return;
    }
    intent.amount = +Math.abs(debtorBalance).toFixed(2);
  }

  await db.query(
    `INSERT INTO settlements (group_id, from_user_id, to_user_id, amount, note)
     VALUES ($1, $2, $3, $4, 'via @mention')`,
    [ctx.chat.id, intent.from_user_id, intent.to_user_id, intent.amount]
  );

  // Mark any open nudges between these two as paid
  await db.query(
    `UPDATE nudges SET paid = TRUE
       WHERE debtor_user_id = $1
         AND receipt_id IN (
           SELECT r.id FROM receipts r
            JOIN receipt_payers rp ON rp.receipt_id = r.id
            WHERE r.group_id = $2 AND rp.user_id = $3
         )`,
    [intent.from_user_id, ctx.chat.id, intent.to_user_id]
  );

  const { rows: names } = await db.query<{ user_id: string; display_name: string }>(
    `SELECT user_id::text, display_name FROM members
      WHERE group_id = $1 AND user_id = ANY($2::bigint[])`,
    [ctx.chat.id, [intent.from_user_id, intent.to_user_id]]
  );
  const nameOf = (uid: number) =>
    names.find((n) => n.user_id === String(uid))?.display_name ?? "someone";

  const { rows: ccyRows } = await db.query<{ home_currency: string }>(
    `SELECT home_currency FROM groups WHERE id = $1`,
    [ctx.chat.id]
  );
  const ccy = ccyRows[0]?.home_currency ?? "SGD";

  await ctx.reply(
    voice.settlementRecorded(
      nameOf(intent.from_user_id),
      nameOf(intent.to_user_id),
      `${intent.amount.toFixed(2)} ${ccy}`
    )
  );
}

async function markDebtCleared(
  ctx: Context,
  intent: Extract<Intent, { kind: "mark_debt_cleared" }>
): Promise<void> {
  if (!ctx.chat || !ctx.from) return;

  // The speaker is implicitly the creditor — the one being paid back
  const creditorId = ctx.from.id;
  const debtorId = intent.debtor_user_id;

  // Look up the current outstanding balance the debtor owes
  const { rows } = await db.query<{ balance: string; home_currency: string }>(
    `SELECT balance::text,
            (SELECT home_currency FROM groups WHERE id = $1) AS home_currency
       FROM member_balances
      WHERE group_id = $1 AND user_id = $2`,
    [ctx.chat.id, debtorId]
  );

  const debtorBalance = Number(rows[0]?.balance ?? 0);
  const ccy = rows[0]?.home_currency ?? "SGD";

  if (debtorBalance >= -0.01) {
    await ctx.reply(voice.nothingOwed());
    return;
  }

  const amount = +Math.abs(debtorBalance).toFixed(2);

  await db.query(
    `INSERT INTO settlements (group_id, from_user_id, to_user_id, amount, note)
     VALUES ($1, $2, $3, $4, 'cleared via @mention')`,
    [ctx.chat.id, debtorId, creditorId, amount]
  );

  // Mark all nudges for this debtor in this group as paid
  await db.query(
    `UPDATE nudges SET paid = TRUE
       WHERE debtor_user_id = $1
         AND receipt_id IN (SELECT id FROM receipts WHERE group_id = $2)`,
    [debtorId, ctx.chat.id]
  );

  const { rows: nameRows } = await db.query<{ display_name: string }>(
    `SELECT display_name FROM members WHERE group_id = $1 AND user_id = $2`,
    [ctx.chat.id, debtorId]
  );
  const debtorName = nameRows[0]?.display_name ?? "they";

  await ctx.reply(voice.debtCleared(debtorName, `${amount.toFixed(2)} ${ccy}`));
}
