// Telegram retries unacknowledged updates with the same update_id. We ack
// webhooks instantly to avoid retries, but this is defense-in-depth: even
// after the 200, a redelivery can race the previous handler's tail.
const seen = new Map<number, number>(); // update_id -> first-seen timestamp
const TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, ts] of seen) {
    if (ts < cutoff) seen.delete(id);
  }
}, 60_000).unref();

export function isDuplicate(updateId: number): boolean {
  if (seen.has(updateId)) return true;
  seen.set(updateId, Date.now());
  return false;
}
