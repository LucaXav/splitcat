import { Bot } from "grammy";
import http from "node:http";
import { env } from "./env.js";
import { log } from "./lib/log.js";
import { isDuplicate } from "./lib/dedup.js";
import { handlePhoto } from "./handlers/photo.js";
import {
  handleStart,
  handleHelp,
  handleBalance,
  handleSettle,
  handleCurrency,
  handleSnooze,
  handlePaid
} from "./handlers/commands.js";
import { handleCallback } from "./handlers/callbacks.js";
import { handleMention, handleReplyTrigger } from "./handlers/mention.js";
import { startScheduler } from "./services/scheduler.js";
import { upsertMember } from "./lib/members.js";
import { buildAssignedReceiptMessage } from "./lib/receipt-summary.js";

const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

// Passive member tracking. Runs before every handler so anyone who sends a
// message — even one not directed at the bot — is upserted into the members
// table. Telegram doesn't expose a "list group members" API to bots, so this
// is how we passively learn who's in the chat.
bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat && !ctx.from.is_bot) {
    try {
      await upsertMember(ctx);
    } catch (e) {
      log.warn({ err: String(e), user: ctx.from.id, chat: ctx.chat.id }, "passive upsert failed");
    }
  }
  await next();
});

// Service messages: someone (or the bot itself) gets added to a group.
bot.on("message:new_chat_members", async (ctx) => {
  for (const u of ctx.message?.new_chat_members ?? []) {
    if (u.is_bot) continue;
    try {
      await upsertMember(ctx, u);
    } catch (e) {
      log.warn({ err: String(e), user: u.id }, "new_chat_members upsert failed");
    }
  }
});

// chat_member updates: a member's role/status changed (joined, promoted, left).
// Requires the bot to be admin OR Privacy Mode disabled, AND chat_member in
// allowed_updates below. We upsert on any non-"left"/"kicked" status so that
// promotions and joins refresh the row.
bot.on("chat_member", async (ctx) => {
  const update = ctx.chatMember;
  if (!update) return;
  const status = update.new_chat_member.status;
  if (status === "left" || status === "kicked") return;
  const u = update.new_chat_member.user;
  if (u.is_bot) return;
  try {
    await upsertMember(ctx, u);
  } catch (e) {
    log.warn({ err: String(e), user: u.id, status }, "chat_member upsert failed");
  }
});

// Commands
bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("balance", handleBalance);
bot.command("settle", handleSettle);
bot.command("currency", handleCurrency);
bot.command("snooze", handleSnooze);
bot.command("paid", handlePaid);

// Photos (receipts)
bot.on("message:photo", handlePhoto);

// @-mentions of the bot — Claude parses intent in plain English
bot.on(":text").filter(
  async (ctx) => {
    if (!ctx.message?.text || !ctx.message.entities) return false;
    const me = await ctx.api.getMe();
    return ctx.message.entities.some(
      (e) =>
        e.type === "mention" &&
        ctx.message!.text!.substring(e.offset, e.offset + e.length).toLowerCase() ===
          `@${me.username.toLowerCase()}`
    );
  },
  handleMention
);

// Replies to one of the bot's own messages — same intent parser as @-mentions.
// Mention handler is registered first, so a reply that ALSO @-mentions the bot
// is handled there and never reaches this filter.
bot.on(":text").filter(
  async (ctx) => {
    if (!ctx.message?.text || !ctx.message.reply_to_message) return false;
    const me = await ctx.api.getMe();
    return ctx.message.reply_to_message.from?.id === me.id;
  },
  handleReplyTrigger
);

// Inline buttons
bot.on("callback_query:data", handleCallback);

// Catch-all error handler — never let an unhandled error take down the process
bot.catch((err) => {
  log.error({ err: String(err.error), update: err.ctx.update.update_id }, "Unhandled bot error");
});

async function main(): Promise<void> {
  // Fetch botInfo upfront. Required because we bypass webhookCallback (which
  // would init lazily on first update) and call bot.handleUpdate directly —
  // grammY needs botInfo populated before handling any update.
  await bot.init();

  // Make sure Telegram knows where to deliver updates
  const webhookPath = "/telegram-webhook";
  const webhookUrl = `${env.PUBLIC_URL.replace(/\/$/, "")}${webhookPath}`;

  await bot.api.setWebhook(webhookUrl, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "chat_member"]
  });
  log.info({ webhookUrl }, "Webhook registered with Telegram");

  // HTTP server. We ACK Telegram webhooks immediately (200) and process the
  // update in the background — Claude Vision photo parses regularly exceed
  // Telegram's 10s webhook timeout, which would otherwise trigger retries
  // and double-process the same update.
  const internalSecret = env.INTERNAL_API_SECRET ?? env.MINI_APP_SECRET;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    // Internal: Mini App calls this after a receipt's split is saved so the
    // bot can edit its original parsed-receipt message — replacing the
    // "Assign items" buttons with a per-person summary.
    if (req.method === "POST" && req.url === "/internal/receipt-assigned") {
      if (req.headers["x-internal-secret"] !== internalSecret) {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            receipt_id?: string;
          };
          if (!body.receipt_id) {
            res.writeHead(400).end();
            return;
          }
          const summary = await buildAssignedReceiptMessage(body.receipt_id);
          if (!summary) {
            // No chat_id/message_id (older row) or no assignments — nothing
            // to edit, but the save itself succeeded so respond 200.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, edited: false }));
            return;
          }
          await bot.api.editMessageText(
            summary.chat_id,
            summary.message_id,
            summary.text,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [] } }
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, edited: true }));
        } catch (e) {
          log.error({ err: String(e) }, "/internal/receipt-assigned failed");
          // Editing the message is best-effort — never bubble back to the
          // Mini App as a hard failure (the assignment itself is committed).
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, edited: false }));
        }
      });
      req.on("error", (e) =>
        log.error({ err: String(e) }, "/internal/receipt-assigned stream error")
      );
      return;
    }
    if (req.method === "POST" && req.url === webhookPath) {
      if (
        req.headers["x-telegram-bot-api-secret-token"] !==
        env.TELEGRAM_WEBHOOK_SECRET
      ) {
        res.writeHead(401).end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        // Ack first — Telegram only cares about the 200, not the body.
        res.writeHead(200).end();

        let update: any;
        try {
          update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (e) {
          log.error({ err: String(e) }, "webhook body parse failed");
          return;
        }

        const updateId = update?.update_id;
        if (typeof updateId === "number" && isDuplicate(updateId)) {
          log.debug({ updateId }, "duplicate update ignored");
          return;
        }

        void bot.handleUpdate(update).catch((err) => {
          log.error({ err: String(err), updateId }, "background update handler failed");
        });
      });
      req.on("error", (e) => {
        log.error({ err: String(e) }, "webhook request stream error");
      });
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(env.PORT, () => {
    log.info({ port: env.PORT }, "Bot HTTP server listening");
  });

  // Start the cron-driven nudge scheduler
  startScheduler(bot);

  // Graceful shutdown
  const shutdown = async (sig: string) => {
    log.info({ sig }, "Shutting down");
    server.close();
    await bot.api.deleteWebhook().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  log.fatal({ err: String(e) }, "Fatal startup error");
  process.exit(1);
});
