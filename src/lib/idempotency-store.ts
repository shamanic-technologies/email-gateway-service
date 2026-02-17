import type { SendResponse } from "../schemas";

interface StoredEntry {
  response: SendResponse;
  statusCode: number;
}

const MAX_SIZE = 10_000;
const store = new Map<string, StoredEntry>();

export function get(key: string): StoredEntry | undefined {
  return store.get(key);
}

export function set(key: string, statusCode: number, response: SendResponse): void {
  // Map preserves insertion order — evict oldest entries when full
  if (store.size >= MAX_SIZE) {
    const oldest = store.keys().next().value!;
    store.delete(oldest);
  }
  store.set(key, { response, statusCode });
}

export function clear(): void {
  store.clear();
}
