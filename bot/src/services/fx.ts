import { log } from "../lib/log.js";

type CacheEntry = { rate: number; fetched_at: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Returns rate such that:  amount_in_home = amount_in_from * rate
 * Returns null if the lookup fails — caller decides what to do.
 *
 * Uses open.er-api.com which has a free tier and doesn't require a key.
 */
export async function getFxRate(from: string, to: string): Promise<{ rate: number; source: string } | null> {
  if (from === to) return { rate: 1, source: "same-currency" };
  const key = `${from}->${to}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetched_at < TTL_MS) {
    return { rate: cached.rate, source: "cache" };
  }
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) throw new Error(`FX API ${res.status}`);
    const json = (await res.json()) as { result: string; rates: Record<string, number> };
    if (json.result !== "success") throw new Error("FX API non-success");
    const rate = json.rates[to];
    if (typeof rate !== "number") throw new Error(`No rate for ${to}`);
    cache.set(key, { rate, fetched_at: Date.now() });
    return { rate, source: "open.er-api.com" };
  } catch (e) {
    log.warn({ err: String(e), from, to }, "FX lookup failed");
    return null;
  }
}
