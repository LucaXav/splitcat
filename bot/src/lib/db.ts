import pg from "pg";
import { env } from "../env.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000
});

db.on("error", (err) => {
  // Don't crash on idle client errors
  console.error("pg pool error", err);
});
