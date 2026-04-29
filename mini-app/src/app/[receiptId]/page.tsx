import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { verifySession } from "@/lib/auth";
import AssignmentUI from "@/components/AssignmentUI";
import SplitSummary from "@/components/SplitSummary";
import type { Receipt } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ReceiptPage({
  params,
  searchParams
}: {
  params: Promise<{ receiptId: string }>;
  searchParams: Promise<{ t?: string; u?: string; h?: string }>;
}) {
  const { receiptId } = await params;
  const { t = "", u = "", h = "" } = await searchParams;

  const session = await verifySession({
    token: t,
    user_id: u,
    hmac: h,
    receipt_id: receiptId
  });
  if (!session) notFound();

  const receipt = await loadReceipt(receiptId);
  if (!receipt) notFound();

  // Defense-in-depth: if the receipt has already been assigned (e.g. someone
  // taps a stale Mini App link after the bot's "Split equally" path or after
  // a previous save), show the read-only summary instead of letting them
  // re-assign and clobber the existing split.
  const alreadyAssigned =
    receipt.status === "assigned" ||
    receipt.status === "settled" ||
    receipt.line_items.some((li) => li.assignments.length > 0);

  return (
    <main className="min-h-screen p-4 pb-32">
      {alreadyAssigned ? (
        <SplitSummary receipt={receipt} />
      ) : (
        <AssignmentUI
          receipt={receipt}
          sessionToken={t}
          currentUserId={session.user_id}
        />
      )}
    </main>
  );
}

async function loadReceipt(receiptId: string): Promise<Receipt | null> {
  const { rows } = await db.query(
    `SELECT r.*,
            (
              SELECT json_agg(li ORDER BY li.position)
              FROM (
                SELECT li.id, li.position, li.description,
                       li.quantity, li.unit_price, li.line_total,
                       COALESCE(
                         (SELECT json_agg(json_build_object('user_id', lia.user_id, 'share', lia.share))
                          FROM line_item_assignments lia WHERE lia.line_item_id = li.id),
                         '[]'::json
                       ) AS assignments
                FROM line_items li WHERE li.receipt_id = r.id
                ORDER BY li.position
              ) li
            ) AS line_items,
            (
              SELECT json_agg(json_build_object(
                'user_id', m.user_id,
                'display_name', m.display_name,
                'username', m.username
              ))
              FROM members m WHERE m.group_id = r.group_id
            ) AS members
       FROM receipts r
      WHERE r.id = $1`,
    [receiptId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    ...r,
    receipt_date:
      r.receipt_date == null
        ? null
        : r.receipt_date instanceof Date
          ? r.receipt_date.toISOString().slice(0, 10)
          : String(r.receipt_date),
    uploaded_by: Number(r.uploaded_by),
    subtotal: Number(r.subtotal),
    service_charge: Number(r.service_charge),
    tax: Number(r.tax),
    tip: Number(r.tip),
    total: Number(r.total),
    fx_rate: r.fx_rate == null ? null : Number(r.fx_rate),
    line_items: (r.line_items ?? []).map((li: any) => ({
      ...li,
      quantity: Number(li.quantity),
      unit_price: Number(li.unit_price),
      line_total: Number(li.line_total)
    })),
    members: r.members ?? []
  };
}
