import crypto from "crypto";
import { db } from "./db";

/**
 * The Mini App session flow:
 *
 * 1. n8n creates a random `token` after parsing a receipt.
 * 2. It signs (token, receipt_id, user_id) with MINI_APP_SECRET → `hmac`.
 * 3. It stores the token row in mini_app_sessions (valid 1 hour).
 * 4. The Telegram button URL is
 *      {MINI_APP_URL}/{receipt_id}?t={token}&u={user_id}&h={hmac}
 * 5. This module verifies the HMAC, then checks the DB row.
 *
 * Using our own HMAC (rather than relying solely on Telegram's initData) means
 * the flow also works if the user opens the link outside Telegram (e.g. copies
 * it to a browser for a bigger screen). We still _also_ accept Telegram
 * initData when present, as a secondary signal.
 */

export type Session = {
  receipt_id: string;
  user_id: number;
};

export async function verifySession(params: {
  token: string;
  user_id: string;
  hmac: string;
  receipt_id: string;
}): Promise<Session | null> {
  const secret = process.env.MINI_APP_SECRET;
  if (!secret) throw new Error("MINI_APP_SECRET not set");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${params.token}.${params.receipt_id}.${params.user_id}`)
    .digest("hex");

  // constant-time compare
  const ok =
    expected.length === params.hmac.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(params.hmac));
  if (!ok) return null;

  const { rows } = await db.query(
    `SELECT receipt_id, user_id
       FROM mini_app_sessions
      WHERE token = $1 AND expires_at > now()`,
    [params.token]
  );
  if (!rows.length) return null;
  if (rows[0].receipt_id !== params.receipt_id) return null;
  if (String(rows[0].user_id) !== params.user_id) return null;

  return { receipt_id: rows[0].receipt_id, user_id: Number(rows[0].user_id) };
}
