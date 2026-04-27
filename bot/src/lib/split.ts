/**
 * Compute each user's share of the receipt total, given:
 *  - subtotal & total (for the proportional scaling factor)
 *  - each user's raw subtotal contribution
 *
 * Lean on `total` as ground truth; distribute proportionally so this works
 * for SG (service + GST compounded), JP (tax-inclusive), US (tax + tip
 * separate), etc.
 */
export function computeShares(opts: {
  subtotal: number;
  total: number;
  memberSubtotals: Record<number, number>;
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

export function subtotalsByUser(
  lineItems: Array<{ id: string; line_total: number }>,
  assignments: Array<{ line_item_id: string; user_ids: number[] }>
): Record<number, number> {
  const byId = new Map(lineItems.map((li) => [li.id, li.line_total]));
  const out: Record<number, number> = {};
  for (const a of assignments) {
    const total = byId.get(a.line_item_id);
    if (total === undefined || !a.user_ids.length) continue;
    const per = total / a.user_ids.length;
    for (const uid of a.user_ids) {
      out[uid] = (out[uid] ?? 0) + per;
    }
  }
  return out;
}

/**
 * Greedy minimum-transfer settlement.
 * For N members never produces more than N-1 transfers.
 */
export function suggestSettlements(
  balances: Array<{ user_id: number; display_name: string; balance: number }>
): Array<{ from: { user_id: number; display_name: string }; to: { user_id: number; display_name: string }; amount: number }> {
  const creditors = balances
    .filter((b) => b.balance > 0.01)
    .map((b) => ({ ...b }))
    .sort((a, b) => b.balance - a.balance);
  const debtors = balances
    .filter((b) => b.balance < -0.01)
    .map((b) => ({ ...b }))
    .sort((a, b) => a.balance - b.balance);

  const out: Array<{ from: any; to: any; amount: number }> = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]!;
    const c = creditors[j]!;
    const amt = Math.min(-d.balance, c.balance);
    out.push({
      from: { user_id: d.user_id, display_name: d.display_name },
      to: { user_id: c.user_id, display_name: c.display_name },
      amount: +amt.toFixed(2)
    });
    d.balance += amt;
    c.balance -= amt;
    if (Math.abs(d.balance) < 0.01) i++;
    if (Math.abs(c.balance) < 0.01) j++;
  }
  return out;
}
