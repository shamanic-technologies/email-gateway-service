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

const mockFetch = vi.fn();
global.fetch = mockFetch;

function authedGet(path: string) {
  return request(app)
    .get(path)
    .set("X-API-Key", "test-api-key")
    .set("x-org-id", "org_1")
    .set("x-user-id", "user_1")
    .set("x-run-id", "run_1");
}

const ZERO_DETAIL = { interested: 0, meetingBooked: 0, closed: 0, notInterested: 0, wrongPerson: 0, unsubscribe: 0, neutral: 0, autoReply: 0, outOfOffice: 0 };

const RECIPIENTS = {
  contacted: 1, sent: 1, delivered: 1, opened: 0, bounced: 0, clicked: 0, unsubscribed: 0,
  repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0, repliesDetail: ZERO_DETAIL,
};

// `undefined` = the provider does not serve the key at all.
type Queued = number | null | undefined;

function channel(queued: Queued) {
  return {
    recipientStats: RECIPIENTS,
    emailStats: {
      sent: 2, delivered: 2, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0,
      ...(queued === undefined ? {} : { queued }),
    },
  };
}

function json(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

/** Instantly answers each campaign row with its own `queued`; postmark never serves one. */
function routeProviders(queuedByCampaign: Record<string, Queued>, opts: { dayGrouped?: boolean } = {}) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/workflows/dynasties")) {
      return Promise.resolve(json({ dynasties: [{ workflowDynastySlug: "cold", workflowDynastyName: "Cold", workflowSlugs: ["cold-v1", "cold-v2"] }] }));
    }
    const params = new URL(url).searchParams;
    const campaignId = params.get("campaignId") ?? "";
    const isInstantly = url.startsWith("http://localhost:3011");
    const queued = isInstantly ? queuedByCampaign[campaignId] : undefined;
    const groupBy = params.get("groupBy");
    if (groupBy === "day") {
      return Promise.resolve(json({ groups: [{ key: "2026-10-04", ...channel(undefined) }] }));
    }
    if (groupBy) {
      return Promise.resolve(json({ groups: ["cold-v1", "cold-v2"].map((key) => ({ key, ...channel(queued) })) }));
    }
    return Promise.resolve(json(channel(queued)));
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("broadcast emailStats.queued relay", () => {
  it("relays the provider's queued on a single non-grouped read", async () => {
    routeProviders({ "": 2505 });
    const res = await authedGet("/orgs/stats?type=broadcast&brandId=b1");
    expect(res.status).toBe(200);
    expect(res.body.broadcast.emailStats.queued).toBe(2505);
  });

  it("keeps a provider null as null (unknown), and 0 as 0", async () => {
    routeProviders({ c_null: null, c_zero: 0 });
    const nullRes = await authedGet("/orgs/stats?type=broadcast&campaignId=c_null");
    expect(nullRes.body.broadcast.emailStats).toHaveProperty("queued", null);
    const zeroRes = await authedGet("/orgs/stats?type=broadcast&campaignId=c_zero");
    expect(zeroRes.body.broadcast.emailStats.queued).toBe(0);
  });

  it("sums a campaign family exactly", async () => {
    routeProviders({ a: 5, b: 0, c: 37 });
    const res = await authedGet("/orgs/stats?type=broadcast&campaignIds=a,b,c");
    expect(res.status).toBe(200);
    expect(res.body.broadcast.emailStats.queued).toBe(42);
  });

  it.each([
    ["one member null", { a: 5, b: null, c: 37 }],
    ["the first member null", { a: null, b: 5, c: 37 }],
    ["one member missing the field", { a: 5, b: undefined, c: 37 }],
    ["the first member missing the field", { a: undefined, b: 5, c: 37 }],
  ])("a family sum is null with %s — never null-as-0", async (_label, queued) => {
    routeProviders(queued);
    const res = await authedGet("/orgs/stats?type=broadcast&campaignIds=a,b,c");
    expect(res.status).toBe(200);
    expect(res.body.broadcast.emailStats).toHaveProperty("queued", null);
  });

  it("sums per group key on a grouped family read, with null propagation", async () => {
    routeProviders({ a: 5, b: 7 });
    const res = await authedGet("/orgs/stats?type=broadcast&groupBy=workflowSlug&campaignIds=a,b");
    expect(res.body.groups.map((g: { broadcast: { emailStats: { queued: number } } }) => g.broadcast.emailStats.queued)).toEqual([12, 12]);
    routeProviders({ a: 5, b: null });
    const nulled = await authedGet("/orgs/stats?type=broadcast&groupBy=workflowSlug&campaignIds=a,b");
    expect(nulled.body.groups.map((g: { broadcast: { emailStats: { queued: number } } }) => g.broadcast.emailStats.queued)).toEqual([null, null]);
  });

  it("sums the slugs of a dynasty group, with null propagation", async () => {
    routeProviders({ a: 4 });
    const res = await authedGet("/orgs/stats?type=broadcast&groupBy=workflowDynastySlug&campaignId=a");
    expect(res.body.groups).toEqual([expect.objectContaining({ key: "cold" })]);
    expect(res.body.groups[0].broadcast.emailStats.queued).toBe(8);
    routeProviders({ a: null });
    const nulled = await authedGet("/orgs/stats?type=broadcast&groupBy=workflowDynastySlug&campaignId=a");
    expect(nulled.body.groups[0].broadcast.emailStats).toHaveProperty("queued", null);
    routeProviders({ a: undefined });
    const absent = await authedGet("/orgs/stats?type=broadcast&groupBy=workflowDynastySlug&campaignId=a");
    expect(absent.body.groups[0].broadcast.emailStats).not.toHaveProperty("queued");
  });

  it("stays absent on groupBy=day, single and family", async () => {
    routeProviders({ a: 5, b: 7 }, { dayGrouped: true });
    const single = await authedGet("/orgs/stats?type=broadcast&groupBy=day&campaignId=a");
    expect(single.body.groups[0].broadcast.emailStats).not.toHaveProperty("queued");
    const family = await authedGet("/orgs/stats?type=broadcast&groupBy=day&campaignIds=a,b");
    expect(family.body.groups[0].broadcast.emailStats).not.toHaveProperty("queued");
  });

  it("never invents queued on the transactional block (no type: broadcast carries it, transactional does not)", async () => {
    routeProviders({ a: 5, b: 7 });
    const res = await authedGet("/orgs/stats?campaignIds=a,b");
    expect(res.status).toBe(200);
    expect(res.body.broadcast.emailStats.queued).toBe(12);
    expect(res.body.transactional.emailStats).not.toHaveProperty("queued");
    const tx = await authedGet("/orgs/stats?type=transactional&campaignId=a");
    expect(tx.body.transactional.emailStats).not.toHaveProperty("queued");
  });

  it("relays on the service-auth public route", async () => {
    routeProviders({ a: 3, c: 4 });
    const res = await request(app).get("/public/stats?type=broadcast&campaignIds=a,c").set("X-API-Key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.broadcast.emailStats.queued).toBe(7);
  });
});
