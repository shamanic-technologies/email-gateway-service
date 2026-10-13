import { Pool } from "pg";
import { config } from "../config";

/**
 * The gateway's own Postgres (`email_gateway_service`). Its only job today is
 * remembering which idempotency keys already sent (see idempotency-store.ts).
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      // A dead host fails loud instead of hanging a send forever.
      connectionTimeoutMillis: 15_000,
      max: 5,
    });
    // An idle client erroring (DB restart) emits on the pool; unhandled it
    // would crash the process.
    pool.on("error", (err) => {
      console.error(`[email-gateway] postgres pool error: ${err.message}`);
    });
  }
  return pool;
}
