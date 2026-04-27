import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifySession } from "@/lib/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ receiptId: string }> }
) {
  const { receiptId } = await params;
  const token = req.headers.get("x-session-token") ?? "";
  const userId = req.headers.get("x-user-id") ?? "";
  const hmac = req.nextUrl.searchParams.get("h") ?? "";

  const session = await verifySession({
    token,
    user_id: userId,
    hmac,
    receipt_id: receiptId
  });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rows } = await db.query(`SELECT * FROM receipts WHERE id = $1`, [
    receiptId
  ]);
  if (!rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(rows[0]);
}
