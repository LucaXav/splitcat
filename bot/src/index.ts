import { Bot, webhookCallback } from "grammy";
import http from "node:http";
import { env } from "./env.js";
import { log } from "./lib/log.js";
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
  // Make sure Telegram knows where to deliver updates
  const webhookPath = "/telegram-webhook";
  const webhookUrl = `${env.PUBLIC_URL.replace(/\/$/, "")}${webhookPath}`;

  await bot.api.setWebhook(webhookUrl, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "chat_member"]
  });
  log.info({ webhookUrl }, "Webhook registered with Telegram");

  // HTTP server
  const handle = webhookCallback(bot, "http", {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    if (req.method === "POST" && req.url === webhookPath) {
      try {
        await handle(req, res);
      } catch (e) {
        log.error({ err: String(e) }, "webhook handler error");
        res.writeHead(500).end();
      }
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
