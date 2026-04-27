import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../lib/db.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

async function main() {
  const schemaPath = resolve(__dirname, "../../../db/schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  console.log(`Applying schema from ${schemaPath}`);
  await db.query(sql);
  console.log("✓ Schema applied");
  await db.end();
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
