import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config", () => ({
  config: {
    port: 3009,
    apiKey: "test-api-key",
    postmark: { url: "http://localhost:3010", apiKey: "pm-key" },
    instantly: { url: "http://localhost:3011", apiKey: "inst-key" },
    brand: { url: "http://localhost:3005", apiKey: "brand-key" },
    google: { url: "http://localhost:3012", apiKey: "g-key" },
    key: { url: "", apiKey: "" },
    runs: { url: "", apiKey: "" },
  },
}));

vi.mock("../src/lib/register-providers", () => ({
  registerProviderRequirements: vi.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import { app } from "../src/index";
import * as postmarkClient from "../src/lib/postmark-client";
import * as idempotencyStore from "../src/lib/idempotency-store";
import { neverReachedUpstream, SendOutcomeUnknownError, SEND_TIMEOUT_MS } from "../src/lib/send-fetch";

// SIGNUP-EMAILS-1111: one send request = at most one email. A send is retried
// only when the request provably never left (connection refused); a timeout or
// a dropped connection is never re-sent and is told apart as "outcome unknown".

function refused(): Error {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3010"), { code: "ECONNREFUSED" });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

function reset(): Error {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

const okAnswer = { ok: true, json: () => Promise.resolve({ success: true, messageId: "pm-1" }) } as Response;

const transactional = {
  type: "transactional",
  to: "info@zenotris.com",
  subject: "Revenue made easy. Starts here.",
  htmlBody: "<p>Welcome</p>",
};

function orgPost() {
  return request(app)
    .post("/orgs/send")
    .set("X-API-Key", "test-api-key")
    .set("x-org-id", "org-1")
    .set("x-user-id", "user-1")
    .set("x-run-id", "run-1");
}

describe("postmark send after the client timeout (simulated time)", () => {
  const realTimeout = AbortSignal.timeout;
  let calls = 0;
  let upstreamMs = 0;

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
        const t = setTimeout(() => resolve(okAnswer), upstreamMs);
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

  it("waits for a 23 s postmark answer in ONE call (the old 10 s timeout re-sent it)", async () => {
    upstreamMs = 23_000;
    const p = postmarkClient.sendEmail({ to: "a@x.com", subject: "s" });
    await vi.advanceTimersByTimeAsync(23_000);
    await expect(p).resolves.toMatchObject({ messageId: "pm-1" });
    expect(calls).toBe(1);
  });

  it("postmark answering after the client timeout: exactly ONE upstream POST, outcome unknown", async () => {
    upstreamMs = SEND_TIMEOUT_MS + 5_000;
    const p = postmarkClient.sendEmail({ to: "a@x.com", subject: "s" });
    const settled = expect(p).rejects.toBeInstanceOf(SendOutcomeUnknownError);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 10_000);
    await settled;
    expect(calls).toBe(1);
  });

  it("platform send after the client timeout: exactly ONE upstream POST", async () => {
    upstreamMs = SEND_TIMEOUT_MS + 5_000;
    const p = postmarkClient.sendPlatformEmail({ to: "a@x.com", subject: "s" }, {});
    const settled = expect(p).rejects.toBeInstanceOf(SendOutcomeUnknownError);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 10_000);
    await settled;
    expect(calls).toBe(1);
  });
});

describe("send routes: refused connection retried once, anything else never", () => {
  const mockFetch = vi.fn();

  beforeEach(async () => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
    await idempotencyStore.clear();
  });

  it("connection refused on the first attempt: retried once, 200", async () => {
    mockFetch.mockRejectedValueOnce(refused()).mockResolvedValueOnce(okAnswer);
    const res = await orgPost().send(transactional);
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("connection refused twice: 502, the email was not sent (no third attempt)", async () => {
    mockFetch.mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused());
    const res = await orgPost().send(transactional);
    expect(res.status).toBe(502);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("connection dropped mid-request: ONE POST, 504 send_outcome_unknown, key not remembered", async () => {
    mockFetch.mockRejectedValueOnce(reset());
    const res = await orgPost().send({ ...transactional, idempotencyKey: "welcome:zenotris" });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: "Send outcome unknown", code: "send_outcome_unknown" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await idempotencyStore.get("welcome:zenotris")).toBeUndefined();
  });

  it("platform send timeout: ONE POST, 504 send_outcome_unknown", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const res = await request(app)
      .post("/platform/send")
      .set("X-API-Key", "test-api-key")
      .send({ type: "transactional", to: "a@x.com", subject: "code", textBody: "1" });
    expect(res.status).toBe(504);
    expect(res.body.code).toBe("send_outcome_unknown");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("broadcast send: connection refused retried once", async () => {
    mockFetch.mockRejectedValueOnce(refused()).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
    });
    const res = await orgPost().send({
      type: "broadcast",
      campaignId: "campaign_1",
      to: "lead@example.com",
      subject: "Hello",
      sequence: [{ step: 1, bodyHtml: "<p>Hi</p>", bodyText: "Hi", daysSinceLastStep: 0 }],
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });
});

describe("neverReachedUpstream", () => {
  it("is true only for errors proving the request never left", () => {
    expect(neverReachedUpstream(refused())).toBe(true);
    expect(neverReachedUpstream(reset())).toBe(false);
    expect(neverReachedUpstream(new DOMException("t", "TimeoutError"))).toBe(false);
    expect(neverReachedUpstream(new Error("fetch failed"))).toBe(false);
  });
});
