import type { Receipt } from "@/lib/types";
import { subtotalsByUser, computeShares } from "@/lib/split";

/**
 * Read-only view shown when someone re-opens a Mini App link for a receipt
 * that's already been assigned. Mirrors the per-person breakdown the bot
 * posts back to the Telegram chat after a successful save.
 */
export default function SplitSummary({ receipt }: { receipt: Receipt }) {
  const payer = receipt.members.find((m) => m.user_id === receipt.uploaded_by);

  const assignmentsList = receipt.line_items
    .map((li) => ({
      line_item_id: li.id,
      user_ids: li.assignments.map((a) => a.user_id)
    }))
    .filter((a) => a.user_ids.length > 0);

  const shares = computeShares({
    subtotal: receipt.subtotal > 0 ? receipt.subtotal : receipt.total,
    total: receipt.total,
    memberSubtotals: subtotalsByUser(receipt.line_items, assignmentsList)
  });

  const breakdown = receipt.members
    .map((m) => ({ ...m, amount: shares[m.user_id] ?? 0 }))
    .filter((m) => m.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const homeLabel = (n: number) => {
    const converted = receipt.fx_rate ? n * receipt.fx_rate : n;
    if (receipt.fx_rate && receipt.currency !== receipt.home_currency) {
      return `${n.toFixed(2)} ${receipt.currency} (≈${converted.toFixed(2)} ${receipt.home_currency})`;
    }
    return `${n.toFixed(2)} ${receipt.currency}`;
  };

  return (
    <div className="max-w-xl mx-auto">
      <header className="mb-6">
        <div className="text-sm text-tg-hint">{receipt.receipt_date ?? ""}</div>
        <h1 className="text-xl font-bold">{receipt.merchant ?? "Receipt"}</h1>
        <div className="text-sm text-tg-hint mt-1">
          Total {homeLabel(receipt.total)}
        </div>
      </header>

      <section className="mb-6 rounded-xl bg-tg-secondary-bg p-3">
        <div className="text-xs uppercase tracking-wide text-tg-hint">Paid by</div>
        <div className="font-medium mt-0.5">{payer?.display_name ?? "—"}</div>
      </section>

      <section className="mb-6 rounded-xl bg-tg-secondary-bg p-4 text-center">
        <div className="text-3xl mb-1">😸</div>
        <div className="text-base font-semibold">This receipt's already split.</div>
        <div className="text-sm text-tg-hint mt-1">
          Here's the breakdown — nothing to change here.
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-hint mb-2">
          Split
        </h2>
        <div className="rounded-xl bg-tg-secondary-bg p-3 space-y-1.5">
          {breakdown.length === 0 ? (
            <div className="text-sm text-tg-hint">No assignments recorded.</div>
          ) : (
            breakdown.map((m) => (
              <div key={m.user_id} className="flex justify-between text-sm">
                <span>{m.display_name}</span>
                <span className="tabular-nums">
                  {m.amount.toFixed(2)} {receipt.currency}
                  {receipt.fx_rate && receipt.currency !== receipt.home_currency && (
                    <span className="text-tg-hint ml-1">
                      (≈{(m.amount * receipt.fx_rate).toFixed(2)}{" "}
                      {receipt.home_currency})
                    </span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
