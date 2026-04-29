import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("production"),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  // Public HTTPS URL where this service receives Telegram webhooks.
  // e.g. https://splitcat.yourdomain.com
  PUBLIC_URL: z.string().url(),
  // Optional: secret token Telegram echoes back to prove updates came from them
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-"),

  // Postgres
  DATABASE_URL: z.string().url(),

  // Mini App
  MINI_APP_URL: z.string().url(),
  MINI_APP_SECRET: z.string().min(32),

  // Optional FX
  EXCHANGERATE_API_KEY: z.string().optional(),

  // Server
  PORT: z.coerce.number().default(3000),
  TIMEZONE: z.string().default("Asia/Singapore"),

  // Tuning
  NUDGE_CHECK_CRON: z.string().default("0 */6 * * *"), // every 6h
  CLAUDE_VISION_MODEL: z.string().default("claude-opus-4-7"),
  CLAUDE_MEME_MODEL: z.string().default("claude-haiku-4-5-20251001"),

  // Optional: comma-separated Telegram sticker file_ids. One is picked at
  // random and posted just before the text nudge. Blank/missing → text only.
  NUDGE_STICKER_FILE_IDS: z.string().optional(),

  // Optional: single Telegram sticker file_id sent before the bot's reply
  // when the intent parser detects flattery aimed at the bot.
  FLATTERY_STICKER_FILE_ID: z.string().optional()
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
