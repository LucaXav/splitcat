import cron from "node-cron";
import type { Bot } from "grammy";
import { db } from "../lib/db.js";
import { log } from "../lib/log.js";
import { env } from "../env.js";
import { generateMeme } from "./claude.js";

type DueNudge = {
  receipt_id: string;
  debtor_user_id: number;
  count: number;
  group_id: number;
  merchant: string | null;
  total: string;
  fx_rate: string | null;
  home_currency: string;
  display_name: string;
  username: string | null;
};

export function startScheduler(bot: Bot): void {
  cron.schedule(env.NUDGE_CHECK_CRON, () => runOnce(bot).catch((e) => log.error({ err: String(e) }, "scheduler tick failed")), {
    timezone: env.TIMEZONE
  });
  log.info({ cron: env.NUDGE_CHECK_CRON, tz: env.TIMEZONE }, "Nudge scheduler started");
}

export async function runOnce(bot: Bot): Promise<void> {
  const { rows } = await db.query<DueNudge>(`
    SELECT
      n.receipt_id,
      n.debtor_user_id,
      n.count,
      r.group_id,
      r.merchant,
      r.total::text,
      r.fx_rate::text,
      r.home_currency,
      m.display_name,
      m.username
    FROM nudges n
    JOIN receipts r ON r.id = n.receipt_id
    JOIN members m  ON m.group_id = r.group_id AND m.user_id = n.debtor_user_id
    WHERE n.paid = FALSE
      AND n.count < 5
      AND (m.nudges_muted_until IS NULL OR m.nudges_muted_until < now())
      AND (
        (n.count = 0 AND r.created_at < now() - interval '1 day')
        OR (n.count = 1 AND n.last_nudged_at < now() - interval '2 days')
        OR (n.count = 2 AND n.last_nudged_at < now() - interval '4 days')
        OR (n.count = 3 AND n.last_nudged_at < now() - interval '7 days')
        OR (n.count = 4 AND n.last_nudged_at < now() - interval '14 days')
      )
    LIMIT 50
  `);

  if (rows.length === 0) {
    log.debug("No nudges due");
    return;
  }
  log.info({ count: rows.length }, "Processing due nudges");

  for (const r of rows) {
    try {
      const total = Number(r.total);
      const fx = r.fx_rate ? Number(r.fx_rate) : 1;
      const amount_home = total * fx;

      const text = await generateMeme({
        level: r.count + 1,
        display_name: r.display_name,
        username: r.username,
        amount_home,
        home_currency: r.home_currency,
        merchant: r.merchant
      });

      // Optional sticker preface. Failure must not block the text nudge.
      const fileIds = (env.NUDGE_STICKER_FILE_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (fileIds.length > 0) {
        const fileId = fileIds[Math.floor(Math.random() * fileIds.length)]!;
        try {
          await bot.api.sendSticker(r.group_id, fileId);
        } catch (err) {
          log.warn(
            { err: String(err), fileId },
            "failed to send sticker, continuing with text"
          );
        }
      }

      await bot.api.sendMessage(r.group_id, text, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ I've paid",
                callback_data: `paid:${r.receipt_id}:${r.debtor_user_id}`
              }
            ],
            [
              {
                text: "⏰ Snooze 24h",
                callback_data: `snooze:${r.receipt_id}:${r.debtor_user_id}:24h`
              }
            ]
          ]
        }
      });

      await db.query(
        `UPDATE nudges SET count = count + 1, last_nudged_at = now()
          WHERE receipt_id = $1 AND debtor_user_id = $2`,
        [r.receipt_id, r.debtor_user_id]
      );

      log.info(
        { receipt_id: r.receipt_id, debtor: r.debtor_user_id, level: r.count + 1 },
        "Nudge sent"
      );
    } catch (e) {
      log.error({ err: String(e), receipt_id: r.receipt_id }, "Failed to send nudge");
    }
  }
}
