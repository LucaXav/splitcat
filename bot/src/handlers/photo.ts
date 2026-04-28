import type { Context } from "grammy";
import { InputFile } from "grammy";
import { db } from "../lib/db.js";
import { log } from "../lib/log.js";
import { env } from "../env.js";
import { parseReceipt } from "../services/claude.js";
import { getFxRate } from "../services/fx.js";
import { generateSessionToken, buildMiniAppUrl } from "../lib/hmac.js";
import * as voice from "../lib/voice.js";

export async function handlePhoto(ctx: Context): Promise<void> {
  if (!ctx.message?.photo || !ctx.from || !ctx.chat) return;

  // Largest size is the last one Telegram returns
  const largest = ctx.message.photo[ctx.message.photo.length - 1]!;

  // Friendly "thinking" reply we'll edit later
  const placeholder = await ctx.reply(voice.receiptParsing());

  try {
    // Fetch group's home currency
    const { rows: gRows } = await db.query<{ home_currency: string }>(
      `SELECT home_currency FROM groups WHERE id = $1`,
      [ctx.chat.id]
    );
    const home_currency = gRows[0]?.home_currency ?? "SGD";

    // Download the photo
    const file = await ctx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const imgRes = await fetch(fileUrl);
    if (!imgRes.ok) throw new Error(`Failed to download photo: ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const base64 = buf.toString("base64");

    // Parse with Claude vision
    const parsed = await parseReceipt(base64, "image/jpeg");

    // FX lookup if foreign currency
    let fx_rate = 1;
    let fx_source = "same-currency";
    let total_home = parsed.total;
    if (parsed.currency !== home_currency) {
      const lookup = await getFxRate(parsed.currency, home_currency);
      if (lookup) {
        fx_rate = lookup.rate;
        fx_source = lookup.source;
        total_home = +(parsed.total * fx_rate).toFixed(2);
      } else {
        fx_rate = 0; // signal "unknown"
        fx_source = "unknown";
      }
    }

    // Insert receipt + line items in a transaction
    const client = await db.connect();
    let receipt_id: string;
    try {
      await client.query("BEGIN");
      const r = await client.query<{ id: string }>(
        `INSERT INTO receipts (
           group_id, uploaded_by, merchant, receipt_date, currency,
           subtotal, service_charge, tax, tip, total,
           fx_rate, fx_source, home_currency, photo_file_id, raw_ocr, status
         ) VALUES (
           $1,$2,$3,$4,$5,
           $6,$7,$8,$9,$10,
           $11,$12,$13,$14,$15,'pending_assignment'
         ) RETURNING id`,
        [
          ctx.chat.id, ctx.from.id, parsed.merchant, parsed.date, parsed.currency,
          parsed.subtotal, parsed.service_charge, parsed.tax, parsed.tip, parsed.total,
          fx_rate || null, fx_source, home_currency, largest.file_id, JSON.stringify(parsed)
        ]
      );
      receipt_id = r.rows[0]!.id;

      for (const [i, li] of parsed.line_items.entries()) {
        await client.query(
          `INSERT INTO line_items (receipt_id, position, description, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [receipt_id, i + 1, li.description, li.quantity, li.unit_price, li.line_total]
        );
      }
      // Uploader is the payer — no separate "who paid?" step.
      await client.query(
        `INSERT INTO receipt_payers (receipt_id, user_id, amount_paid)
         VALUES ($1, $2, $3)`,
        [receipt_id, ctx.from.id, parsed.total]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // Build a Mini App session
    const token = generateSessionToken();
    await db.query(
      `INSERT INTO mini_app_sessions (token, receipt_id, user_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [token, receipt_id, ctx.from.id]
    );
    const miniAppUrl = buildMiniAppUrl({ receipt_id, user_id: ctx.from.id, token });

    // Reply
    const fxNote =
      parsed.currency !== home_currency && fx_rate > 0
        ? ` → ${total_home.toFixed(2)} ${home_currency}`
        : parsed.currency !== home_currency
          ? ` (FX rate unavailable — please confirm in app)`
          : "";

    const lowConfNote =
      parsed.confidence === "low" ? `\n⚠️ Low confidence — double-check the items. ${parsed.notes ?? ""}` : "";

    const text = `🧾 *${escape(parsed.merchant ?? "Receipt")}*\n${parsed.total.toFixed(2)} ${parsed.currency}${fxNote}\nPaid by ${escape(ctx.from.first_name ?? "you")} · ${parsed.line_items.length} items.\n\nTap below to assign who had what 👇${lowConfNote}`;

    await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🐾 Assign items", url: miniAppUrl }],
          [{ text: "Split equally", callback_data: `split_equal:${receipt_id}` }]
        ]
      }
    });
  } catch (e) {
    log.error({ err: String(e) }, "Photo handling failed");
    await ctx.api.editMessageText(
      ctx.chat.id,
      placeholder.message_id,
      voice.receiptFailed()
    );
  }
}

function escape(s: string): string {
  return s.replace(/([_*[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}
