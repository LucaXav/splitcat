import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
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
  if (!body?.assignments?.length) {
    return NextResponse.json({ error: "no assignments" }, { status: 400 });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Wipe previous assignments on this receipt — user is re-submitting.
    await client.query(
      `DELETE FROM line_item_assignments
        WHERE line_item_id IN (SELECT id FROM line_items WHERE receipt_id = $1)`,
      [receiptId]
    );
    await client.query(`DELETE FROM receipt_payers WHERE receipt_id = $1`, [
      receiptId
    ]);

    // Re-insert assignments as equal-share rows (share = 1 each, division
    // happens at query time in the balances view).
    for (const a of body.assignments) {
      for (const uid of a.user_ids) {
        await client.query(
          `INSERT INTO line_item_assignments (line_item_id, user_id, share)
           VALUES ($1, $2, 1)
           ON CONFLICT (line_item_id, user_id) DO UPDATE SET share = 1`,
          [a.line_item_id, uid]
        );
      }
    }

    for (const p of body.payers) {
      await client.query(
        `INSERT INTO receipt_payers (receipt_id, user_id, amount_paid)
         VALUES ($1, $2, $3)`,
        [receiptId, p.user_id, p.amount_paid]
      );
    }

    await client.query(
      `UPDATE receipts SET status = 'assigned' WHERE id = $1`,
      [receiptId]
    );

    // Create nudge rows for each debtor (everyone except the payer).
    await client.query(
      `INSERT INTO nudges (receipt_id, debtor_user_id, count)
       SELECT DISTINCT $1, lia.user_id, 0
         FROM line_item_assignments lia
         JOIN line_items li ON li.id = lia.line_item_id
        WHERE li.receipt_id = $1
          AND lia.user_id NOT IN (SELECT user_id FROM receipt_payers WHERE receipt_id = $1)
       ON CONFLICT DO NOTHING`,
      [receiptId]
    );

    // Consume the session so the link can't be replayed.
    await client.query(`DELETE FROM mini_app_sessions WHERE token = $1`, [token]);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return NextResponse.json({ ok: true });
}
