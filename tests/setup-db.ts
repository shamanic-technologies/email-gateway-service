import { vi, beforeAll } from "vitest";

// Every test file imports the app, whose send routes read the idempotency
// store. Back it with an in-memory Postgres (pg-mem) so the real SQL runs.
vi.mock("../src/lib/db", async () => {
  const { newDb } = await import("pg-mem");
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  return { getPool: () => pool };
});

beforeAll(async () => {
  const store = await import("../src/lib/idempotency-store");
  await store.ensureSchema();
});
