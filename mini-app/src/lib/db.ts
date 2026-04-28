import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Lazy: `neon()` throws if DATABASE_URL is missing, and Next.js evaluates this
// module during `next build` page-data collection (no env vars present).
let _client: NeonQueryFunction<false, false> | null = null;
function client(): NeonQueryFunction<false, false> {
  if (!_client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _client = neon(url);
  }
  return _client;
}

export const sql: NeonQueryFunction<false, false> = new Proxy(
  function () {} as unknown as NeonQueryFunction<false, false>,
  {
    apply(_t, thisArg, args) {
      return (client() as any).apply(thisArg, args);
    },
    get(_t, prop) {
      const c = client();
      const v = (c as any)[prop];
      return typeof v === "function" ? v.bind(c) : v;
    }
  }
);

export const db = {
  async query<T = any>(text: string, values?: any[]): Promise<{ rows: T[] }> {
    const rows = (await sql(text, values ?? [])) as unknown as T[];
    return { rows };
  }
};
