import type { Context, CommandContext } from "grammy";
import { db } from "../lib/db.js";
import { suggestSettlements } from "../lib/split.js";
import * as voice from "../lib/voice.js";

export async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  const me = await ctx.api.getMe();
  await ctx.reply(
    `👋 The cat has arrived. I'm SplitCat.

Add me to a group, snap a receipt, I'll do the math. Whoever uploads is the payer — don't try to weasel out of it.

Just @ me in plain English:
  • "@${me.username} who owes who"
  • "@${me.username} I paid Priya 20"
  • "@${me.username} Priya cleared her tab"

Or use /help if you like buttons more than vibes.`
  );
}

export async function handleHelp(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(
    `📖 *SplitCat — what I do*

📸 *Snap a receipt photo* — I parse it, you assign who had what. The uploader is the payer. No backsies.

💬 *@ me in plain English:*
  • "@SplitCatBot who owes who"
  • "@SplitCatBot I paid Priya 20"
  • "@SplitCatBot Priya cleared her tab"
  • "@SplitCatBot settle up"

*Slash commands* if you're old-school:
/balance — the damage
/settle — the cleanest path to zero
/currency SGD — set home currency
/paid @user 20 — record a settlement
/snooze 7d — mute the cat
/help — this message

Foreign-currency receipts auto-convert when you travel.

I cap nudges at 5 per debt. After that I get bored.`,
    { parse_mode: "Markdown" }
  );
}

export async function handleBalance(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.chat) return;
  const { rows } = await db.query<{ display_name: string; balance: string; home_currency: string }>(
    `SELECT display_name, balance::text,
            (SELECT home_currency FROM groups WHERE id = $1) AS home_currency
       FROM member_balances
      WHERE group_id = $1
      ORDER BY balance DESC`,
    [ctx.chat.id]
  );
  if (!rows.length) {
    await ctx.reply(voice.noActivity());
    return;
  }
  const ccy = rows[0]!.home_currency;
  const lines = rows.map((r) => {
    const bal = Number(r.balance);
    const tag = bal > 0.01 ? "🟢 is owed" : bal < -0.01 ? "🔴 owes   " : "⚪ settled ";
    const name = r.display_name.padEnd(12);
    return `${tag} ${name} ${Math.abs(bal).toFixed(2)} ${ccy}`;
  });
  const hasOpenBalances = rows.some((r) => Math.abs(Number(r.balance)) > 0.01);
  await ctx.reply(`${voice.balanceHeader()}\n\`\`\`\n${lines.join("\n")}\n\`\`\``, {
    parse_mode: "Markdown",
    ...(hasOpenBalances && {
      reply_markup: {
        inline_keyboard: [[{ text: "🤝 Settle up", callback_data: "settle_up" }]]
      }
    })
  });
}

export async function handleSettle(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.chat) return;
  const { rows } = await db.query<{ user_id: string; display_name: string; balance: string; home_currency: string }>(
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
  // One row per suggested transfer. Tapping records the settlement directly,
  // skipping the natural-language parse path. Callback data carries the full
  // tuple so the handler can verify auth and write the settlement atomically.
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

export async function handleCurrency(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.chat) return;
  const arg = (ctx.match ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(arg)) {
    await ctx.reply("Usage: `/currency SGD` (any ISO 4217 code)", { parse_mode: "Markdown" });
    return;
  }
  await db.query(`UPDATE groups SET home_currency = $2 WHERE id = $1`, [ctx.chat.id, arg]);
  await ctx.reply(voice.currencySet(arg), { parse_mode: "Markdown" });
}

export async function handleSnooze(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const arg = (ctx.match ?? "7d").trim();
  const m = /^(\d+)\s*(d|h|w)$/i.exec(arg);
  if (!m) {
    await ctx.reply("Usage: `/snooze 7d` (also accepts `24h`, `1w`)", { parse_mode: "Markdown" });
    return;
  }
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const interval = unit === "h" ? `${n} hours` : unit === "w" ? `${n} weeks` : `${n} days`;
  await db.query(
    `UPDATE members SET nudges_muted_until = now() + $3::interval
      WHERE group_id = $1 AND user_id = $2`,
    [ctx.chat.id, ctx.from.id, interval]
  );
  await ctx.reply(voice.snoozed(interval));
}

export async function handlePaid(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.chat || !ctx.from || !ctx.message) return;
  const arg = (ctx.match ?? "").trim();
  // Forms: "@user 20" or "20 @user"
  const userMention = arg.match(/@(\w+)/);
  const amountMatch = arg.match(/(\d+(?:\.\d+)?)/);
  if (!userMention || !amountMatch) {
    await ctx.reply("Usage: `/paid @username 20.50`", { parse_mode: "Markdown" });
    return;
  }
  const username = userMention[1];
  const amount = Number(amountMatch[1]);

  const { rows: target } = await db.query<{ user_id: string }>(
    `SELECT user_id::text FROM members WHERE group_id = $1 AND username = $2`,
    [ctx.chat.id, username]
  );
  if (!target.length) {
    await ctx.reply(voice.unknownMember(username!));
    return;
  }
  await db.query(
    `INSERT INTO settlements (group_id, from_user_id, to_user_id, amount, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [ctx.chat.id, ctx.from.id, target[0]!.user_id, amount, `via /paid`]
  );
  await ctx.reply(
    voice.settlementRecorded(ctx.from.first_name ?? "you", `@${username}`, amount.toFixed(2)) +
      " /balance to verify."
  );
}
