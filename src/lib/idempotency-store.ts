import type { SendResponse } from "../schemas";

interface StoredEntry {
  response: SendResponse;
  statusCode: number;
  expiresAt: number;
}

const store = new Map<string, StoredEntry>();

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function get(key: string): StoredEntry | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

export function set(key: string, statusCode: number, response: SendResponse): void {
  store.set(key, {
    response,
    statusCode,
    expiresAt: Date.now() + TTL_MS,
  });
}

function cleanup(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) {
      store.delete(key);
    }
  }
}

export function clear(): void {
  store.clear();
}

// Periodic cleanup of expired entries
const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();
