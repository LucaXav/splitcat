import type { Context } from "grammy";
import { db } from "../lib/db.js";
import { log } from "../lib/log.js";
import { suggestSettlements } from "../lib/split.js";
import * as voice from "../lib/voice.js";

export async function handleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.chat || !ctx.from) return;

  const parts = data.split(":");
  const action = parts[0];

  try {
    if (action === "split_equal" && parts[1]) {
      await splitEqually(ctx, parts[1]);
    } else if (action === "mark_paid" && parts[1]) {
      // Legacy callback from nudges sent before the paid:<receipt>:<debtor>
      // format existed. Pre-existing messages in users' chats still reference
      // it; remove this once those messages are old enough to be ignored.
      await markPaid(ctx, parts[1]);
    } else if (action === "settle" && parts.length === 5) {
      await confirmSettlement(ctx, {
        groupId: parts[1]!,
        fromUserId: parts[2]!,
        toUserId: parts[3]!,
        amount: parts[4]!
      });
    } else if (action === "settle_up") {
      await runSettleSuggestion(ctx);
    } else if (action === "paid" && parts.length === 3) {
      await confirmReceiptPaid(ctx, { receiptId: parts[1]!, debtorUserId: parts[2]! });
    } else if (action === "snooze" && parts.length === 4) {
      await snoozeNudge(ctx, {
        receiptId: parts[1]!,
        debtorUserId: parts[2]!,
        duration: parts[3]!
      });
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown action." });
    }
  } catch (e) {
    log.error({ err: String(e), data }, "Callback handling failed");
    await ctx.answerCallbackQuery({ text: "Something went wrong." });
  }
}

async function splitEqually(ctx: Context, receiptId: string): Promise<void> {
  if (!ctx.chat || !ctx.from) return;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Verify receipt belongs to this group
    const { rows: rRows } = await client.query<{ group_id: string; total: string }>(
      `SELECT group_id::text, total::text FROM receipts WHERE id = $1`,
      [receiptId]
    );
    if (!rRows.length || rRows[0]!.group_id !== String(ctx.chat.id)) {
      throw new Error("Receipt not found in this group");
    }

    // Equal split among all known members of this group
    await client.query(
      `INSERT INTO line_item_assignments (line_item_id, user_id, share)
       SELECT li.id, m.user_id, 1
         FROM line_items li
         CROSS JOIN members m
        WHERE li.receipt_id = $1 AND m.group_id = $2
       ON CONFLICT (line_item_id, user_id) DO UPDATE SET share = 1`,
      [receiptId, ctx.chat.id]
    );

    // Payer = whoever tapped the button
    await client.query(
      `INSERT INTO receipt_payers (receipt_id, user_id, amount_paid)
       VALUES ($1, $2, $3)
       ON CONFLICT (receipt_id, user_id) DO UPDATE SET amount_paid = EXCLUDED.amount_paid`,
      [receiptId, ctx.from.id, rRows[0]!.total]
    );

    await client.query(`UPDATE receipts SET status = 'assigned' WHERE id = $1`, [receiptId]);

    // Create nudge rows for all debtors (everyone except payer)
    await client.query(
      `INSERT INTO nudges (receipt_id, debtor_user_id, count)
       SELECT $1, m.user_id, 0
         FROM members m
        WHERE m.group_id = $2 AND m.user_id <> $3
       ON CONFLICT DO NOTHING`,
      [receiptId, ctx.chat.id, ctx.from.id]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await ctx.answerCallbackQuery({ text: "Split equally ✓" });
  await ctx.reply(
    `🐾 Split equally among everyone. ${ctx.from.first_name} paid. Use /balance to see the running tab.`
  );
}

async function markPaid(ctx: Context, receiptId: string): Promise<void> {
  if (!ctx.from) return;
  await db.query(
    `UPDATE nudges SET paid = TRUE WHERE receipt_id = $1 AND debtor_user_id = $2`,
    [receiptId, ctx.from.id]
  );
  await ctx.answerCallbackQuery({ text: "Marked paid 😸" });
}

/**
 * "[💰 Mark as paid]" tapped under a settle-up suggestion. Records a direct
 * settlement between the payer and payee at the suggested amount.
 *
 * Auth: only the payer (from) or the payee (to) may confirm — anyone else in
 * the group tapping is rejected at the cb-query level. The Telegram from.id
 * on the callback query is trusted.
 */
async function confirmSettlement(
  ctx: Context,
  args: { groupId: string; fromUserId: string; toUserId: string; amount: string }
): Promise<void> {
  if (!ctx.chat || !ctx.from) return;

  const groupId = Number(args.groupId);
  const fromUserId = Number(args.fromUserId);
  const toUserId = Number(args.toUserId);
  const amount = Number(args.amount);

  if (
    !Number.isFinite(groupId) ||
    !Number.isFinite(fromUserId) ||
    !Number.isFinite(toUserId) ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    await ctx.answerCallbackQuery({ text: "Bad button data." });
    return;
  }

  if (groupId !== ctx.chat.id) {
    await ctx.answerCallbackQuery({ text: "Wrong chat." });
    return;
  }

  if (ctx.from.id !== fromUserId && ctx.from.id !== toUserId) {
    await ctx.answerCallbackQuery({
      text: "Only the payer or payee can confirm this.",
      show_alert: true
    });
    return;
  }

  await db.query(
    `INSERT INTO settlements (group_id, from_user_id, to_user_id, amount, note)
     VALUES ($1, $2, $3, $4, 'Confirmed via button')`,
    [groupId, fromUserId, toUserId, amount]
  );

  // Mark any open nudges between this debtor and any receipt paid by `to` in
  // this group as paid — the explicit settlement covers them.
  await db.query(
    `UPDATE nudges SET paid = TRUE
       WHERE debtor_user_id = $1
         AND receipt_id IN (
           SELECT r.id FROM receipts r
            JOIN receipt_payers rp ON rp.receipt_id = r.id
            WHERE r.group_id = $2 AND rp.user_id = $3
         )`,
    [fromUserId, groupId, toUserId]
  );

  const { rows: nameRows } = await db.query<{ user_id: string; display_name: string }>(
    `SELECT user_id::text, display_name FROM members
      WHERE group_id = $1 AND user_id = ANY($2::bigint[])`,
    [groupId, [fromUserId, toUserId]]
  );
  const nameOf = (uid: number) =>
    nameRows.find((n) => n.user_id === String(uid))?.display_name ?? "someone";

  const { rows: ccyRows } = await db.query<{ home_currency: string }>(
    `SELECT home_currency FROM groups WHERE id = $1`,
    [groupId]
  );
  const ccy = ccyRows[0]?.home_currency ?? "SGD";

  await ctx.answerCallbackQuery({ text: "Settled ✓" });
  await replaceMessageWithConfirmation(
    ctx,
    `✅ Settled: ${nameOf(fromUserId)} → ${nameOf(toUserId)} ${amount.toFixed(2)} ${ccy}`
  );
}

/**
 * "[🤝 Settle up]" tapped under a balance display. Re-runs the settle
 * suggestion flow inline so the user gets the suggested transfers with
 * per-row settle buttons.
 */
async function runSettleSuggestion(ctx: Context): Promise<void> {
  if (!ctx.chat) return;

  await ctx.answerCallbackQuery();

  const { rows } = await db.query<{
    user_id: string;
    display_name: string;
    balance: string;
    home_currency: string;
  }>(
    `SELECT user_id::text, display_name, balance::text,
            (SELECT home_currency FROM groups WHERE id = $1) AS home_currency
       FROM member_balances
      WHERE group_id = $1 AND abs(balance) > 0.01
      ORDER BY balance DESC`,
    [ctx.chat.id]
  );
  if (!rows.length) {
    await ctx.reply(voice.allSettled());
    return;
  }
  const ccy = rows[0]!.home_currency;
  const transfers = suggestSettlements(
    rows.map((r) => ({
      user_id: Number(r.user_id),
      display_name: r.display_name,
      balance: Number(r.balance)
    }))
  );
  const text =
    `${voice.settleHeader()}\n` +
    transfers
      .map((t) => `💸 ${t.from.display_name} → ${t.to.display_name}: ${t.amount.toFixed(2)} ${ccy}`)
      .join("\n");
  const inline_keyboard = transfers.map((t) => [
    {
      text: `💰 ${t.from.display_name} → ${t.to.display_name} ${t.amount.toFixed(2)}`,
      callback_data: `settle:${ctx.chat!.id}:${t.from.user_id}:${t.to.user_id}:${t.amount.toFixed(2)}`
    }
  ]);
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard }
  });
}

/**
 * "[✅ I've paid]" tapped on a nudge. Inserts a settlement covering the
 * debtor's share of that specific receipt and marks the nudge paid so the
 * scheduler stops chasing them.
 *
 * Auth: only the debtor named in the callback may confirm.
 */
async function confirmReceiptPaid(
  ctx: Context,
  args: { receiptId: string; debtorUserId: string }
): Promise<void> {
  if (!ctx.from) return;

  const debtorUserId = Number(args.debtorUserId);
  if (!Number.isFinite(debtorUserId)) {
    await ctx.answerCallbackQuery({ text: "Bad button data." });
    return;
  }
  if (ctx.from.id !== debtorUserId) {
    await ctx.answerCallbackQuery({
      text: "Only the person being nudged can mark this paid.",
      show_alert: true
    });
    return;
  }

  // Compute the debtor's share for this receipt in home currency, mirroring
  // the member_balances view's per-receipt math (line_total × share / sum
  // shares × tax/service uplift × fx). Pick the receipt's largest payer as
  // the creditor — multi-payer receipts are rare in practice.
  const { rows: shareRows } = await db.query<{
    group_id: string;
    share_home: string | null;
    home_currency: string;
    payer_id: string | null;
  }>(
    `SELECT
       r.group_id::text AS group_id,
       r.home_currency,
       SUM(
         li.line_total * lia.share / total_shares.sum_shares
         * (r.total / NULLIF(r.subtotal, 0))
         * COALESCE(r.fx_rate, 1)
       )::text AS share_home,
       (
         SELECT rp.user_id::text
           FROM receipt_payers rp
          WHERE rp.receipt_id = r.id
          ORDER BY rp.amount_paid DESC
          LIMIT 1
       ) AS payer_id
     FROM receipts r
     JOIN line_items li ON li.receipt_id = r.id
     JOIN line_item_assignments lia ON lia.line_item_id = li.id
     JOIN LATERAL (
       SELECT SUM(share) AS sum_shares
         FROM line_item_assignments
        WHERE line_item_id = li.id
     ) total_shares ON TRUE
     WHERE r.id = $1 AND lia.user_id = $2
     GROUP BY r.id, r.group_id, r.home_currency`,
    [args.receiptId, debtorUserId]
  );

  const row = shareRows[0];
  if (!row || !row.payer_id || row.share_home == null) {
    // No share computed (no assignments) or no payer recorded — just mark the
    // nudge paid so the scheduler stops, but skip the settlement insert.
    await db.query(
      `UPDATE nudges SET paid = TRUE WHERE receipt_id = $1 AND debtor_user_id = $2`,
      [args.receiptId, debtorUserId]
    );
    await ctx.answerCallbackQuery({ text: "Marked paid 😸" });
    await replaceMessageWithConfirmation(ctx, "✅ Confirmed");
    return;
  }

  const groupId = Number(row.group_id);
  const payerId = Number(row.payer_id);
  const shareHome = +Number(row.share_home).toFixed(2);

  if (shareHome > 0) {
    await db.query(
      `INSERT INTO settlements (group_id, from_user_id, to_user_id, amount, note)
       VALUES ($1, $2, $3, $4, 'Confirmed via button')`,
      [groupId, debtorUserId, payerId, shareHome]
    );
  }

  await db.query(
    `UPDATE nudges SET paid = TRUE WHERE receipt_id = $1 AND debtor_user_id = $2`,
    [args.receiptId, debtorUserId]
  );

  await ctx.answerCallbackQuery({ text: "Marked paid 😸" });
  await replaceMessageWithConfirmation(ctx, "✅ Confirmed");
}

/**
 * "[⏰ Snooze 24h]" tapped on a nudge. The nudges table doesn't have a
 * per-row next_nudge_at, so we suspend nudges to this debtor across the
 * group via members.nudges_muted_until — the scheduler already honours it.
 * Trade-off: snoozes ALL of this debtor's nudges in this group, not just
 * this receipt. In practice that matches "give me a day" intent better.
 *
 * Auth: only the debtor named in the callback may snooze.
 */
async function snoozeNudge(
  ctx: Context,
  args: { receiptId: string; debtorUserId: string; duration: string }
): Promise<void> {
  if (!ctx.chat || !ctx.from) return;

  const debtorUserId = Number(args.debtorUserId);
  if (!Number.isFinite(debtorUserId)) {
    await ctx.answerCallbackQuery({ text: "Bad button data." });
    return;
  }
  if (ctx.from.id !== debtorUserId) {
    await ctx.answerCallbackQuery({
      text: "Only the person being nudged can snooze.",
      show_alert: true
    });
    return;
  }

  // Only "24h" is wired through the UI; reject anything else defensively.
  if (args.duration !== "24h") {
    await ctx.answerCallbackQuery({ text: "Unsupported snooze duration." });
    return;
  }

  await db.query(
    `UPDATE members
        SET nudges_muted_until = GREATEST(
              COALESCE(nudges_muted_until, now()),
              now() + interval '24 hours'
            )
      WHERE group_id = $1 AND user_id = $2`,
    [ctx.chat.id, debtorUserId]
  );

  await ctx.answerCallbackQuery({ text: "Snoozed 😴" });
  await ctx.reply("👌 snoozed for 24 hours");
}

/**
 * Strip the inline keyboard off the message that the callback fired from
 * and append a confirmation line to its text. Falls back gracefully when
 * the original message can't be edited (e.g. it was a sticker).
 */
async function replaceMessageWithConfirmation(ctx: Context, confirmation: string): Promise<void> {
  const original = ctx.callbackQuery?.message;
  const originalText = original && "text" in original ? (original.text as string | undefined) : undefined;
  try {
    if (originalText) {
      await ctx.editMessageText(`${originalText}\n\n${confirmation}`);
    } else {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      await ctx.reply(confirmation);
    }
  } catch (e) {
    log.warn({ err: String(e) }, "Failed to edit confirmation into message; replying instead");
    await ctx.reply(confirmation);
  }
}
