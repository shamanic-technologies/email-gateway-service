export const TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const MAX_ENTRIES = 10_000;

const store = new Map<string, number>(); // messageId -> insertion timestamp

/**
 * Check if a Postmark inbound MessageID has already been forwarded.
 * Returns true if the ID was seen before (caller should skip).
 * Returns false if newly seen (caller should proceed; the ID is now registered).
 *
 * Bounded to MAX_ENTRIES with FIFO eviction. Entries also expire after TTL_MS.
 */
export function seen(messageId: string): boolean {
  const now = Date.now();
  const insertedAt = store.get(messageId);
  if (insertedAt !== undefined) {
    if (now - insertedAt > TTL_MS) {
      store.delete(messageId);
      register(messageId, now);
      return false;
    }
    return true;
  }
  register(messageId, now);
  return false;
}

function register(messageId: string, now: number): void {
  if (store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  store.set(messageId, now);
}

export function clear(): void {
  store.clear();
}
