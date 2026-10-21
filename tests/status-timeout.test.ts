import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("../src/lib/register-providers", () => ({
  registerProviderRequirements: vi.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import { app } from "../src/index";
import * as instantlyClient from "../src/lib/instantly-client";

// The delivery-status read (POST /orgs/status) waits for instantly-service's
// cold answer (~16 s for a 10k-address brand, 2026-10-22) and never re-asks
// after a timeout. Time is simulated: AbortSignal.timeout is rebuilt on the
// faked setTimeout, and the upstream answers after `upstreamMs`.
const body = { brandId: "b1", items: [{ email: "a@x.com" }] };
const answer = { results: [{ email: "a@x.com", byCampaign: null, campaign: null, brand: null, global: { email: { bounced: false, unsubscribed: false } } }] };

let calls = 0;
let upstreamMs = 0;
const realTimeout = AbortSignal.timeout;

beforeEach(() => {
  vi.useFakeTimers();
  calls = 0;
  AbortSignal.timeout = ((ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
    return c.signal;
  }) as typeof AbortSignal.timeout;
  global.fetch = ((_url: string, init?: RequestInit) => {
    calls++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => resolve({ ok: true, json: () => Promise.resolve(answer) } as Response),
        upstreamMs,
      );
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(init.signal!.reason);
      });
    });
  }) as typeof fetch;
});

afterEach(() => {
  AbortSignal.timeout = realTimeout;
  vi.useRealTimers();
});

describe("instantly getStatus on the delivery-status route", () => {
  it("returns a 16 s cold answer in one call (the route waits 60 s)", async () => {
    upstreamMs = 16_000;
    const p = instantlyClient.getStatus(body, undefined, instantlyClient.STATUS_ROUTE_READ);
    await vi.advanceTimersByTimeAsync(16_000);
    await expect(p).resolves.toEqual(answer);
    expect(calls).toBe(1);
    expect(instantlyClient.STATUS_ROUTE_READ.timeoutMs).toBe(60_000);
  });

  it("does not retry a call aborted on timeout", async () => {
    upstreamMs = 120_000;
    const p = instantlyClient.getStatus(body, undefined, instantlyClient.STATUS_ROUTE_READ);
    const settled = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(130_000);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/instantly-service POST \/orgs\/status/);
    expect(calls).toBe(1);
  });

  it("other callers keep 10 s + one retry (follow-up route unchanged)", async () => {
    upstreamMs = 16_000;
    const p = instantlyClient.getStatus(body);
    const settled = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await settled).toBeInstanceOf(Error);
    expect(calls).toBe(2);
  });
});

describe("POST /orgs/status route", () => {
  it("returns 200 when instantly-service answers after 16 s (was a 502 at ~21 s)", async () => {
    vi.useRealTimers();
    // Record each upstream's timeout, then answer instantly: the route must ask
    // instantly-service with the 60 s budget, postmark-service unchanged.
    const asked: Record<string, number> = {};
    let lastMs = 0;
    AbortSignal.timeout = ((ms: number) => {
      lastMs = ms;
      return new AbortController().signal;
    }) as typeof AbortSignal.timeout;
    global.fetch = (async (url: string) => {
      asked[new URL(url).port] = lastMs;
      return { ok: true, json: () => Promise.resolve(answer) } as Response;
    }) as typeof fetch;
    const res = await request(app)
      .post("/orgs/status")
      .set("X-API-Key", "test-api-key")
      .set("x-org-id", "org_1")
      .set("x-brand-id", "brand_1")
      .send(body);
    expect(res.status).toBe(200);
    expect(asked["3011"]).toBe(60_000);
    expect(asked["3010"]).toBe(10_000);
  });
});
