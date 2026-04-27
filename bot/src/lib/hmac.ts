import crypto from "node:crypto";
import { env } from "../env.js";

export function generateSessionToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function signSession(params: {
  token: string;
  receipt_id: string;
  user_id: number;
}): string {
  return crypto
    .createHmac("sha256", env.MINI_APP_SECRET)
    .update(`${params.token}.${params.receipt_id}.${params.user_id}`)
    .digest("hex");
}

export function buildMiniAppUrl(params: {
  receipt_id: string;
  user_id: number;
  token: string;
}): string {
  const hmac = signSession(params);
  return `${env.MINI_APP_URL}/${params.receipt_id}?t=${params.token}&u=${params.user_id}&h=${hmac}`;
}
