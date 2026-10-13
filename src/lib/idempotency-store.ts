import { getPool } from "./db";

/**
 * Durable record of sends whose idempotency key already SUCCEEDED, so a repeat
 * of that key is answered as a duplicate (nothing sent, the earlier response)
 * across restarts and deploys.
 *
 * Why Postgres and not process memory: campaign-service redelivers a trigger
 * occurrence to a campaign when its run did not complete (same occurrence id,
 * up to 6 runs over ~3h45), and workflow-service keys its sends on that
 * occurrence. The box redeploys this service on every merge to main, often
 * several times an hour, so an in-memory map forgot the key and the
 * redelivered run mailed the same person twice (REDELIVERY-IDEMPOTENCY-1014).
 *
 * Only successes are recorded. A refusal (sender 4xx) or an upstream failure
 * (502) is not, so a retry asks again — same as before.
 *
 * Keys live 7 days: the redelivery window is ~4h, a day was the old in-memory
 * TTL, a week leaves room for a slow manual re-run.
 */

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface StoredEntry {
  response: Record<string, unknown>;
  statusCode: number;
}

export async function ensureSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key text PRIMARY KEY,
      status_code integer NOT NULL,
      response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )
  `);
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx ON idempotency_keys (expires_at)`,
  );
}

/** Read failures propagate: a send that cannot check its key must not go out. */
export async function get(key: string): Promise<StoredEntry | undefined> {
  const { rows } = await getPool().query(
    `SELECT status_code, response FROM idempotency_keys WHERE key = $1 AND expires_at > $2`,
    [key, new Date()],
  );
  if (rows.length === 0) return undefined;
  return { statusCode: rows[0].status_code, response: rows[0].response as Record<string, unknown> };
}

/**
 * Records a key AFTER the email went out. A failure here is logged and
 * swallowed by the caller on purpose: the send already happened, so answering
 * 502 would make the caller retry and mail the person a second time.
 */
export async function set(key: string, statusCode: number, response: object): Promise<void> {
  await getPool().query(
    `INSERT INTO idempotency_keys (key, status_code, response, expires_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (key) DO UPDATE
       SET status_code = EXCLUDED.status_code,
           response = EXCLUDED.response,
           created_at = now(),
           expires_at = EXCLUDED.expires_at`,
    [key, statusCode, JSON.stringify(response), new Date(Date.now() + TTL_MS)],
  );
}

/** Records a key; logs (never throws) because the email is already sent. */
export async function remember(key: string, statusCode: number, response: object): Promise<void> {
  try {
    await set(key, statusCode, response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email-gateway] idempotency record FAILED after a sent email key=${key}: ${message}`);
  }
}

export async function cleanupExpired(): Promise<number> {
  const { rowCount } = await getPool().query(`DELETE FROM idempotency_keys WHERE expires_at <= $1`, [new Date()]);
  return rowCount ?? 0;
}

export function startCleanup(): void {
  const timer = setInterval(() => {
    cleanupExpired().catch((err: unknown) => {
      console.error(`[email-gateway] idempotency cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
}

/** Test helper. */
export async function clear(): Promise<void> {
  await getPool().query(`DELETE FROM idempotency_keys`);
}
