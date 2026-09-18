import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";

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
    features: { url: "http://features:3020", apiKey: "feat-key" },
    workflow: { url: "http://workflow:3021", apiKey: "wf-key" },
    runs: { url: "", apiKey: "" },
  },
}));

const API_KEY = "test-api-key";
const mockFetch = vi.fn();
global.fetch = mockFetch;

const ZERO_DETAIL = {
  interested: 0, meetingBooked: 0, closed: 0, notInterested: 0, wrongPerson: 0,
  unsubscribe: 0, neutral: 0, autoReply: 0, outOfOffice: 0,
};

function recipientStats(overrides: Record<string, unknown> = {}) {
  return {
    contacted: 0, sent: 0, delivered: 0, opened: 0, bounced: 0, clicked: 0, unsubscribed: 0,
    repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0,
    repliesDetail: { ...ZERO_DETAIL },
    ...overrides,
  };
}

function emailStats(overrides: Record<string, unknown> = {}) {
  return { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0, ...overrides };
}

function ok(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

function serviceAuthGet(path: string) {
  return request(app).get(path).set("X-API-Key", API_KEY);
}

function authedGet(path: string) {
  return request(app)
    .get(path)
    .set("X-API-Key", API_KEY)
    .set("x-org-id", "org_1")
    .set("x-user-id", "user_1")
    .set("x-run-id", "run_1");
}

/**
 * The read exists because an empty match and a measured zero used to be the
 * same response. Most of what is asserted below is that they are not any more.
 */
describe("GET /stats/by-operation", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("reports an operation nothing belongs to as unmatched, with no stats block", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({ tag: "never-ran", matched: false, messageCount: 0 })
    );

    const res = await serviceAuthGet("/public/stats/by-operation?operationId=never-ran");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ operationId: "never-ran", matched: false, messageCount: 0 });
    expect(res.body).not.toHaveProperty("transactional");
    expect(res.body).not.toHaveProperty("broadcast");
  });

  it("returns the operation's outcomes when messages back them", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        tag: "mailing-list-release-7",
        matched: true,
        messageCount: 30013,
        recipientStats: recipientStats({ contacted: 30013, sent: 30013, delivered: 29800, bounced: 213, unsubscribed: 41 }),
        emailStats: emailStats({ sent: 30013, delivered: 29800, bounced: 213, unsubscribed: 41 }),
      })
    );

    const res = await serviceAuthGet("/public/stats/by-operation?operationId=mailing-list-release-7");

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.messageCount).toBe(30013);
    expect(res.body.transactional.emailStats.sent).toBe(30013);
    expect(res.body.transactional.emailStats.bounced).toBe(213);
    expect(res.body.transactional.emailStats.unsubscribed).toBe(41);
    expect(res.body.transactional.recipientStats.delivered).toBe(29800);
  });

  it("distinguishes a matched all-zero operation from an unmatched one", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        tag: "just-started",
        matched: true,
        messageCount: 5,
        recipientStats: recipientStats({ contacted: 5, sent: 5, delivered: 5 }),
        emailStats: emailStats({ sent: 5, delivered: 5 }),
      })
    );

    const res = await serviceAuthGet("/public/stats/by-operation?operationId=just-started");

    expect(res.body.matched).toBe(true);
    expect(res.body.transactional.emailStats.bounced).toBe(0);
    expect(res.body.transactional.emailStats.unsubscribed).toBe(0);
  });

  it("asks the provider for exactly one operation, by tag, in one request", async () => {
    mockFetch.mockResolvedValueOnce(ok({ tag: "op with spaces/&", matched: false, messageCount: 0 }));

    await serviceAuthGet(`/public/stats/by-operation?operationId=${encodeURIComponent("op with spaces/&")}`);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/internal/stats/by-tag");
    expect(url).toContain(`tag=${encodeURIComponent("op with spaces/&")}`);
  });

  it("uses the org-scoped provider route when the caller has an org", async () => {
    mockFetch.mockResolvedValueOnce(ok({ tag: "op", matched: false, messageCount: 0 }));

    await authedGet("/orgs/stats/by-operation?operationId=op");

    expect(mockFetch.mock.calls[0][0]).toContain("/orgs/stats/by-tag");
  });

  it("rejects a request with no operationId", async () => {
    const res = await serviceAuthGet("/public/stats/by-operation");

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails loud when the provider is unreachable, rather than answering zero", async () => {
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await serviceAuthGet("/public/stats/by-operation?operationId=op");

    expect(res.status).toBe(502);
    expect(res.body).not.toHaveProperty("matched");
  });

  it("fails loud when the provider claims a match but serves no figures", async () => {
    mockFetch.mockResolvedValueOnce(ok({ tag: "op", matched: true, messageCount: 4 }));

    const res = await serviceAuthGet("/public/stats/by-operation?operationId=op");

    expect(res.status).toBe(502);
  });
});
