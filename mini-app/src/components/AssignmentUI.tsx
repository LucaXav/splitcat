"use client";

import { useMemo, useState, useEffect } from "react";
import type { Receipt } from "@/lib/types";
import { subtotalsByUser, computeShares } from "@/lib/split";

declare global {
  interface Window {
    Telegram?: { WebApp?: any };
  }
}

export default function AssignmentUI({
  receipt,
  sessionToken,
  currentUserId
}: {
  receipt: Receipt;
  sessionToken: string;
  currentUserId: number;
}) {
  // Map of line_item.id -> Set<user_id>
  const [assignments, setAssignments] = useState<Record<string, Set<number>>>(
    () => {
      const init: Record<string, Set<number>> = {};
      for (const li of receipt.line_items) {
        init[li.id] = new Set(li.assignments.map((a) => a.user_id));
      }
      return init;
    }
  );
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const payer = receipt.members.find((m) => m.user_id === receipt.uploaded_by);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready?.();
    tg?.expand?.();
  }, []);

  const toggle = (lineId: string, userId: number) => {
    setAssignments((prev) => {
      const next = { ...prev };
      const set = new Set(next[lineId]);
      if (set.has(userId)) set.delete(userId);
      else set.add(userId);
      next[lineId] = set;
      return next;
    });
  };

  const selectAll = (lineId: string) => {
    setAssignments((prev) => ({
      ...prev,
      [lineId]: new Set(receipt.members.map((m) => m.user_id))
    }));
  };

  const clearAll = (lineId: string) => {
    setAssignments((prev) => ({ ...prev, [lineId]: new Set() }));
  };

  const livePreview = useMemo(() => {
    const assignmentsList = Object.entries(assignments)
      .filter(([, users]) => users.size > 0)
      .map(([line_item_id, users]) => ({
        line_item_id,
        user_ids: Array.from(users)
      }));
    const subs = subtotalsByUser(receipt.line_items, assignmentsList);
    return computeShares({
      subtotal: receipt.subtotal,
      total: receipt.total,
      memberSubtotals: subs
    });
  }, [assignments, receipt]);

  const unassigned = receipt.line_items.filter(
    (li) => (assignments[li.id]?.size ?? 0) === 0
  );

  const submit = async () => {
    setSubmitting(true);
    try {
      const payload = {
        payers: [{ user_id: receipt.uploaded_by, amount_paid: receipt.total }],
        assignments: Object.entries(assignments)
          .filter(([, users]) => users.size > 0)
          .map(([line_item_id, users]) => ({
            line_item_id,
            user_ids: Array.from(users)
          }))
      };
      const res = await fetch(`/api/receipts/${receipt.id}/assign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": sessionToken,
          "X-User-Id": String(currentUserId)
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || "Assignment failed");
      }
      setDone(true);
      const tg = window.Telegram?.WebApp;
      if (tg) {
        tg.HapticFeedback?.notificationOccurred?.("success");
        setTimeout(() => tg.close?.(), 1200);
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const homeLabel = (n: number) => {
    const converted = receipt.fx_rate ? n * receipt.fx_rate : n;
    if (receipt.fx_rate && receipt.currency !== receipt.home_currency) {
      return `${n.toFixed(2)} ${receipt.currency} (≈${converted.toFixed(2)} ${receipt.home_currency})`;
    }
    return `${n.toFixed(2)} ${receipt.currency}`;
  };

  if (done) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="text-6xl mb-4">😸</div>
        <div className="text-xl font-semibold">Saved!</div>
        <div className="text-tg-hint mt-2">You can close this.</div>
      </div>
    );
  }

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

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-hint mb-2">
          Items
        </h2>
        <div className="space-y-3">
          {receipt.line_items.map((li) => {
            const selected = assignments[li.id] ?? new Set<number>();
            return (
              <div
                key={li.id}
                className="rounded-xl bg-tg-secondary-bg p-3"
              >
                <div className="flex items-baseline justify-between mb-2">
                  <div className="font-medium">
                    {li.quantity > 1 ? `${li.quantity}× ` : ""}
                    {li.description}
                  </div>
                  <div className="text-sm tabular-nums">
                    {li.line_total.toFixed(2)} {receipt.currency}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {receipt.members.map((m) => (
                    <button
                      key={m.user_id}
                      onClick={() => toggle(li.id, m.user_id)}
                      className={`px-2.5 py-1 rounded-full text-xs ${
                        selected.has(m.user_id)
                          ? "bg-tg-button text-tg-button-text"
                          : "bg-tg-bg border border-tg-hint/30 text-tg-text"
                      }`}
                    >
                      {m.display_name}
                    </button>
                  ))}
                  <button
                    onClick={() => selectAll(li.id)}
                    className="px-2.5 py-1 rounded-full text-xs text-tg-link"
                  >
                    all
                  </button>
                  {selected.size > 0 && (
                    <button
                      onClick={() => clearAll(li.id)}
                      className="px-2.5 py-1 rounded-full text-xs text-tg-hint"
                    >
                      clear
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tg-hint mb-2">
          Split preview
        </h2>
        <div className="rounded-xl bg-tg-secondary-bg p-3 space-y-1.5">
          {receipt.members.map((m) => (
            <div key={m.user_id} className="flex justify-between text-sm">
              <span>{m.display_name}</span>
              <span className="tabular-nums">
                {(livePreview[m.user_id] ?? 0).toFixed(2)} {receipt.currency}
                {receipt.fx_rate && receipt.currency !== receipt.home_currency && (
                  <span className="text-tg-hint ml-1">
                    (≈{((livePreview[m.user_id] ?? 0) * receipt.fx_rate).toFixed(2)}{" "}
                    {receipt.home_currency})
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-tg-bg border-t border-tg-hint/20">
        <button
          disabled={submitting || unassigned.length > 0}
          onClick={submit}
          className="w-full py-3 rounded-xl bg-tg-button text-tg-button-text font-semibold disabled:opacity-40"
        >
          {submitting
            ? "Saving..."
            : unassigned.length > 0
              ? `${unassigned.length} item${unassigned.length > 1 ? "s" : ""} unassigned`
              : "Save split"}
        </button>
      </div>
    </div>
  );
}
