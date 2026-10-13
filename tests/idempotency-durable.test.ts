import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";
import * as idempotencyStore from "../src/lib/idempotency-store";
import { getPool } from "../src/lib/db";

vi.mock("../src/lib/register-providers", () => ({
  registerProviderRequirements: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config", () => ({
  config: {
    port: 3009,
    apiKey: "test-api-key",
    postmark: { url: "http://localhost:3010", apiKey: "pm-key" },
    instantly: { url: "http://localhost:3011", apiKey: "inst-key" },
    brand: { url: "http://localhost:3005", apiKey: "brand-key" },
    key: { url: "", apiKey: "" },
    runs: { url: "", apiKey: "" },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function broadcastBody(overrides = {}) {
  return {
    type: "broadcast",
    campaignId: "campaign_1",
    to: "lead@example.com",
    subject: "Hello",
    sequence: [{ step: 1, bodyHtml: "<p>Hi</p>", bodyText: "Hi", daysSinceLastStep: 0 }],
    ...overrides,
  };
}

function post() {
  return request(app).post("/orgs/send").set("X-API-Key", "test-api-key").set("x-org-id", "org_1");
}

function okInstantly() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
  });
}

function failQueriesStartingWith(verb: string) {
  const pool = getPool();
  const real = pool.query.bind(pool);
  return vi.spyOn(pool, "query").mockImplementation(((text: string, values?: unknown[]) => {
    if (text.trim().startsWith(verb)) return Promise.reject(new Error("connection refused"));
    return real(text, values);
  }) as typeof pool.query);
}

describe("idempotency survives a restart (REDELIVERY-IDEMPOTENCY-1014)", () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await idempotencyStore.clear();
  });

  it("records a successful send in Postgres, not in process memory", async () => {
    okInstantly();
    const res = await post().send(broadcastBody({ idempotencyKey: "occ-1:send" }));
    expect(res.status).toBe(200);

    const { rows } = await getPool().query(
      "SELECT status_code, response FROM idempotency_keys WHERE key = $1",
      ["occ-1:send"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status_code).toBe(200);
    expect(rows[0].response).toEqual({ success: true, provider: "broadcast", messageId: "l1", campaignId: "c1" });
  });

  it("answers a key written by a PREVIOUS process as a duplicate and sends nothing", async () => {
    // A row left by the process that ran before the redeploy.
    await idempotencyStore.set("occ-2:send", 200, {
      success: true,
      provider: "broadcast",
      messageId: "l-earlier",
      campaignId: "c-earlier",
    });

    const res = await post().send(broadcastBody({ idempotencyKey: "occ-2:send" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      provider: "broadcast",
      messageId: "l-earlier",
      campaignId: "c-earlier",
      deduplicated: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends again once the key has expired", async () => {
    await getPool().query(
      "INSERT INTO idempotency_keys (key, status_code, response, expires_at) VALUES ($1, 200, $2::jsonb, $3)",
      ["occ-3:send", JSON.stringify({ success: true, provider: "broadcast" }), new Date(Date.now() - 1000)],
    );
    okInstantly();

    const res = await post().send(broadcastBody({ idempotencyKey: "occ-3:send" }));

    expect(res.status).toBe(200);
    expect(res.body.deduplicated).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await idempotencyStore.cleanupExpired()).toBe(0);
  });

  it("refuses with a 502 and sends nothing when the key cannot be checked", async () => {
    const spy = failQueriesStartingWith("SELECT");

    const res = await post().send(broadcastBody({ idempotencyKey: "occ-4:send" }));

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Idempotency store unavailable");
    expect(mockFetch).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still answers the first send's 200 when recording the key fails afterwards", async () => {
    const spy = failQueriesStartingWith("INSERT");
    okInstantly();

    const res = await post().send(broadcastBody({ idempotencyKey: "occ-5:send" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, provider: "broadcast", messageId: "l1", campaignId: "c1" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
