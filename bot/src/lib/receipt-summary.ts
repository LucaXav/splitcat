import { db } from "./db.js";

export type ReceiptSummary = {
  chat_id: number;
  message_id: number;
  text: string;
};

/**
 * Build the edited-message body shown after a receipt has been assigned.
 * Mirrors the header format produced by the photo handler (merchant, total,
 * FX note, payer line) and replaces the call-to-action with a per-person
 * breakdown in the receipt's own currency.
 *
 * Shares are computed exactly the way `/balance` computes them — line_total
 * × share / sum_shares, scaled by total/subtotal to fold tax/service/tip in.
 * Returns null if the receipt has no chat_id/message_id (older rows) or
 * no assignments yet.
 */
export async function buildAssignedReceiptMessage(
  receiptId: string
): Promise<ReceiptSummary | null> {
  const { rows: rRows } = await db.query<{
    chat_id: string | null;
    message_id: string | null;
    merchant: string | null;
    currency: string;
    total: string;
    fx_rate: string | null;
    home_currency: string;
    payer_name: string | null;
    item_count: string;
  }>(
    `SELECT
       r.chat_id::text,
       r.message_id::text,
       r.merchant,
       r.currency,
       r.total::text,
       r.fx_rate::text,
       r.home_currency,
       (
         SELECT m.display_name FROM receipt_payers rp
           JOIN members m ON m.user_id = rp.user_id AND m.group_id = r.group_id
          WHERE rp.receipt_id = r.id
          ORDER BY rp.amount_paid DESC
          LIMIT 1
       ) AS payer_name,
       (SELECT COUNT(*)::text FROM line_items li WHERE li.receipt_id = r.id) AS item_count
     FROM receipts r
     WHERE r.id = $1`,
    [receiptId]
  );
  const r = rRows[0];
  if (!r || !r.chat_id || !r.message_id) return null;

  const { rows: shareRows } = await db.query<{
    display_name: string;
    share_amt: string;
  }>(
    `SELECT m.display_name,
            SUM(
              li.line_total * lia.share / total_shares.sum_shares
              * COALESCE(r.total / NULLIF(r.subtotal, 0), 1)
            )::text AS share_amt
       FROM receipts r
       JOIN line_items li ON li.receipt_id = r.id
       JOIN line_item_assignments lia ON lia.line_item_id = li.id
       JOIN members m ON m.user_id = lia.user_id AND m.group_id = r.group_id
       JOIN LATERAL (
         SELECT SUM(share) AS sum_shares
           FROM line_item_assignments
          WHERE line_item_id = li.id
       ) total_shares ON TRUE
      WHERE r.id = $1
      GROUP BY m.user_id, m.display_name
      ORDER BY share_amt DESC`,
    [receiptId]
  );
  if (!shareRows.length) return null;

  const total = Number(r.total);
  const fxRate = r.fx_rate == null ? null : Number(r.fx_rate);
  const isForeign = r.currency !== r.home_currency;
  const totalHome = fxRate && fxRate > 0 ? +(total * fxRate).toFixed(2) : null;

  const fxNote = isForeign
    ? totalHome != null
      ? ` → ${totalHome.toFixed(2)} ${r.home_currency}`
      : ` (FX rate unavailable)`
    : "";

  const itemCount = Number(r.item_count);
  const payerLine =
    r.payer_name != null
      ? `Paid by ${escape(r.payer_name)} · ${itemCount} items.`
      : `${itemCount} items.`;

  // Mirror /balance's monospace formatting: pad names to a fixed width, right-
  // align amounts. Width follows the widest display name in the breakdown.
  const nameWidth = Math.max(
    8,
    ...shareRows.map((s) => s.display_name.length)
  );
  const amtWidth = Math.max(
    ...shareRows.map((s) => Number(s.share_amt).toFixed(2).length)
  );
  const summaryLines = shareRows.map((s) => {
    const amt = Number(s.share_amt).toFixed(2).padStart(amtWidth);
    const name = s.display_name.padEnd(nameWidth);
    return `${name} ${amt} ${r.currency}`;
  });

  const text =
    `🧾 *${escape(r.merchant ?? "Receipt")}*\n` +
    `${total.toFixed(2)} ${r.currency}${fxNote}\n` +
    `${payerLine}\n\n` +
    `✅ Split done:\n` +
    "```\n" +
    summaryLines.join("\n") +
    "\n```";

  return {
    chat_id: Number(r.chat_id),
    message_id: Number(r.message_id),
    text
  };
}

function escape(s: string): string {
  return s.replace(/([_*[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}
