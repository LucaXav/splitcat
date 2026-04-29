import { NextRequest, NextResponse } from "next/server";
import { db, sql } from "@/lib/db";
import type { AssignmentPayload } from "@/lib/types";

/**
 * We accept the token via header (since it was signed into the URL the user
 * is already on). We re-fetch the session row and confirm the receipt match.
 * No HMAC needed here because the token is already server-issued + DB-backed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ receiptId: string }> }
) {
  const { receiptId } = await params;
  const token = req.headers.get("x-session-token") ?? "";
  const userIdHeader = req.headers.get("x-user-id") ?? "";

  const { rows: sessions } = await db.query(
    `SELECT receipt_id, user_id FROM mini_app_sessions
      WHERE token = $1 AND expires_at > now()`,
    [token]
  );
  if (!sessions.length) {
    return NextResponse.json({ error: "session expired" }, { status: 401 });
  }
  if (sessions[0].receipt_id !== receiptId) {
    return NextResponse.json({ error: "receipt mismatch" }, { status: 403 });
  }
  if (String(sessions[0].user_id) !== userIdHeader) {
    return NextResponse.json({ error: "user mismatch" }, { status: 403 });
  }

  const body = (await req.json()) as AssignmentPayload;
  const hasAssignments = (body?.assignments?.length ?? 0) > 0;
  const equalSplitUsers = body?.equal_split?.user_ids ?? [];
  const hasEqualSplit = equalSplitUsers.length > 0;
  if (!hasAssignments && !hasEqualSplit) {
    return NextResponse.json({ error: "no assignments" }, { status: 400 });
  }

  // Wipe previous assignments on this receipt — user is re-submitting.
  const stmts = [
    sql`DELETE FROM line_item_assignments
         WHERE line_item_id IN (SELECT id FROM line_items WHERE receipt_id = ${receiptId})`,
    sql`DELETE FROM receipt_payers WHERE receipt_id = ${receiptId}`
  ];

  // Card-slip path: receipt has no parsed line items, so synthesise one with
  // the receipt's total and split it equally among the chosen users. The rest
  // of the system (balances, nudges) keeps treating it as a normal line item.
  if (hasEqualSplit) {
    const { rows } = await db.query<{ total: string }>(
      `SELECT total::text FROM receipts WHERE id = $1`,
      [receiptId]
    );
    if (!rows.length) {
      return NextResponse.json({ error: "receipt not found" }, { status: 404 });
    }
    const total = Number(rows[0].total);
    const syntheticItemId = crypto.randomUUID();

    // Drop any prior synthetic items so re-submits don't pile up.
    stmts.push(
      sql`DELETE FROM line_items WHERE receipt_id = ${receiptId}`
    );
    stmts.push(sql`
      INSERT INTO line_items (id, receipt_id, position, description, quantity, unit_price, line_total)
      VALUES (${syntheticItemId}, ${receiptId}, 1, 'Total bill', 1, ${total}, ${total})
    `);
    for (const uid of equalSplitUsers) {
      stmts.push(sql`
        INSERT INTO line_item_assignments (line_item_id, user_id, share)
        VALUES (${syntheticItemId}, ${uid}, 1)
        ON CONFLICT (line_item_id, user_id) DO UPDATE SET share = 1
      `);
    }
  }

  // Re-insert assignments as equal-share rows (share = 1 each, division
  // happens at query time in the balances view).
  for (const a of body.assignments) {
    for (const uid of a.user_ids) {
      stmts.push(sql`
        INSERT INTO line_item_assignments (line_item_id, user_id, share)
        VALUES (${a.line_item_id}, ${uid}, 1)
        ON CONFLICT (line_item_id, user_id) DO UPDATE SET share = 1
      `);
    }
  }

  for (const p of body.payers) {
    stmts.push(sql`
      INSERT INTO receipt_payers (receipt_id, user_id, amount_paid)
      VALUES (${receiptId}, ${p.user_id}, ${p.amount_paid})
    `);
  }

  stmts.push(
    sql`UPDATE receipts SET status = 'assigned' WHERE id = ${receiptId}`
  );

  // Create nudge rows for each debtor (everyone except the payer).
  stmts.push(sql`
    INSERT INTO nudges (receipt_id, debtor_user_id, count)
    SELECT DISTINCT ${receiptId}::uuid, lia.user_id, 0
      FROM line_item_assignments lia
      JOIN line_items li ON li.id = lia.line_item_id
     WHERE li.receipt_id = ${receiptId}
       AND lia.user_id NOT IN (SELECT user_id FROM receipt_payers WHERE receipt_id = ${receiptId})
    ON CONFLICT DO NOTHING
  `);

  // Consume the session so the link can't be replayed.
  stmts.push(sql`DELETE FROM mini_app_sessions WHERE token = ${token}`);

  await sql.transaction(stmts);

  return NextResponse.json({ ok: true });
}
