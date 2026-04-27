import type { LineItem } from "./types";

/**
 * Given the parsed receipt totals and each member's raw subtotal share,
 * returns each member's share of the FULL total (including proportional
 * service charge, tax, and tip).
 *
 * Math: each person's share of subtotal × (total / subtotal).
 * Works for any tax model — SG (service + GST compounded), JP (tax-inclusive),
 * US (tax + tip separate) — because we lean on `total` as the ground truth
 * and distribute it proportionally.
 */
export function computeShares(opts: {
  subtotal: number;
  total: number;
  memberSubtotals: Record<number, number>; // user_id -> their raw item $
}): Record<number, number> {
  const { subtotal, total, memberSubtotals } = opts;
  if (subtotal <= 0) return {};
  const ratio = total / subtotal;
  const out: Record<number, number> = {};
  for (const [uid, amt] of Object.entries(memberSubtotals)) {
    out[Number(uid)] = +(amt * ratio).toFixed(2);
  }
  return out;
}

/**
 * From line items + assignments (equal split among N users per item),
 * produce each user's subtotal share.
 */
export function subtotalsByUser(
  lineItems: Array<Pick<LineItem, "line_total" | "id">>,
  assignments: Array<{ line_item_id: string; user_ids: number[] }>
): Record<number, number> {
  const byId = new Map(lineItems.map((li) => [li.id, li.line_total]));
  const out: Record<number, number> = {};
  for (const a of assignments) {
    const total = byId.get(a.line_item_id);
    if (!total || !a.user_ids.length) continue;
    const per = total / a.user_ids.length;
    for (const uid of a.user_ids) {
      out[uid] = (out[uid] ?? 0) + per;
    }
  }
  return out;
}
