import type { Context } from "grammy";
import { db } from "../lib/db.js";
import { log } from "../lib/log.js";

export async function handleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.chat || !ctx.from) return;

  const [action, arg] = data.split(":");

  try {
    if (action === "split_equal" && arg) {
      await splitEqually(ctx, arg);
    } else if (action === "mark_paid" && arg) {
      await markPaid(ctx, arg);
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
