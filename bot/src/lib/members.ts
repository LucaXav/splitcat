import type { Context } from "grammy";
import type { User } from "grammy/types";
import { db } from "./db.js";

/**
 * Passive member tracking. Telegram does not let bots enumerate all members
 * of a group, so SplitCat learns about people only as they become observable
 * (sending a message, joining, being @-mentioned, having their role changed).
 * These helpers centralise the upsert logic so every observation point keeps
 * the members table in sync without duplicating SQL.
 */

/**
 * Upsert the chat group + a user as a member of it. If `user` is omitted,
 * upserts ctx.from (the message sender). Bots are skipped — SplitCat itself
 * shouldn't appear in the ledger.
 */
export async function upsertMember(ctx: Context, user?: User): Promise<void> {
  if (!ctx.chat) return;
  const u = user ?? ctx.from;
  if (!u || u.is_bot) return;
  await upsertGroup(ctx);
  await db.query(
    `INSERT INTO members (group_id, user_id, username, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (group_id, user_id) DO UPDATE
       SET username = EXCLUDED.username, display_name = EXCLUDED.display_name`,
    [ctx.chat.id, u.id, u.username ?? null, u.first_name ?? "User"]
  );
}

export async function upsertGroup(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  if (!chat) return;
  const title =
    chat.type === "private" ? "DM" : (chat as { title?: string }).title ?? "Group";
  await db.query(
    `INSERT INTO groups (id, title) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
    [chat.id, title]
  );
}
