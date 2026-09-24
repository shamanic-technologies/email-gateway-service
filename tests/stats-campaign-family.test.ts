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

// Distinct per-row figures, so a sum that drops or double-counts a row shows.
const ROW_SEED: Record<string, number> = { camp_a: 1, camp_b: 10, camp_c: 100 };

function channel(seed: number, withSteps: boolean) {
  return {
    recipientStats: {
      contacted: 3 * seed, sent: 2 * seed, delivered: 2 * seed, opened: seed, bounced: 0, clicked: seed, unsubscribed: 0,
      notSending: seed,
      repliesPositive: seed, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0,
      repliesDetail: { ...ZERO_DETAIL, interested: seed },
    },
    emailStats: {
      sent: 4 * seed, delivered: 4 * seed, opened: seed, clicked: seed, bounced: 0, unsubscribed: 0,
      ...(withSteps
        ? { stepStats: [{ step: 1, sent: 2 * seed, delivered: 2 * seed, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0, repliesDetail: ZERO_DETAIL }] }
        : {}),
    },
  };
}

function json(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

/** Provider answers keyed on the campaignId the gateway forwards — one row each. */
function routeProviders(opts: { failInstantlyFor?: string; grouped?: boolean } = {}) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/workflows/dynasties")) {
      return Promise.resolve(json({ dynasties: [{ workflowDynastySlug: "cold", workflowDynastyName: "Cold", workflowSlugs: ["cold-v1", "cold-v2"] }] }));
    }
    const params = new URL(url).searchParams;
    const campaignId = params.get("campaignId") ?? "";
    const seed = ROW_SEED[campaignId] ?? 0;
    const isInstantly = url.startsWith("http://localhost:3011");
    if (isInstantly && opts.failInstantlyFor === campaignId) {
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("boom") });
    }
    if (params.get("groupBy")) {
      // Row camp_a sent under cold-v1 only; the others under both versions.
      const keys = campaignId === "camp_a" ? ["cold-v1"] : ["cold-v1", "cold-v2"];
      return Promise.resolve(json({ groups: keys.map((key) => ({ key, ...channel(seed, false) })) }));
    }
    return Promise.resolve(json(channel(seed, isInstantly)));
  });
}

/** A test-local, obviously-correct numeric sum to compare against. */
function naiveSum(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (typeof a === "number") return a + (b as number);
  if (Array.isArray(a)) return a.map((x, i) => ({ ...(naiveSum(x, (b as unknown[])[i]) as object), step: (x as { step: number }).step }));
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
    out[key] = naiveSum((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
  }
  return out;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("GET /orgs/stats?campaignIds= (campaign family in one read)", () => {
  it("answers the sum of the per-row answers, with no type (both providers)", async () => {
    routeProviders();
    const perRow = [];
    for (const id of ["camp_a", "camp_b", "camp_c"]) {
      const res = await authedGet(`/orgs/stats?brandId=b1&campaignId=${id}`);
      expect(res.status).toBe(200);
      perRow.push(res.body);
    }
    const expected = perRow.reduce((acc, body) => naiveSum(acc, body));

    const family = await authedGet("/orgs/stats?brandId=b1&campaignIds=camp_a,camp_b,camp_c");
    expect(family.status).toBe(200);
    expect(family.body).toEqual(expected);
    expect(family.body.broadcast.recipientStats.contacted).toBe(333);
    expect(family.body.broadcast.recipientStats.notSending).toBe(111);
    expect(family.body.broadcast.emailStats.stepStats).toEqual([expect.objectContaining({ step: 1, sent: 222 })]);
    expect(family.body.transactional.emailStats.sent).toBe(444);
    expect(family.body.byCampaign).toBeUndefined();
  });

  it("forwards each row as its own campaignId and never forwards campaignIds", async () => {
    routeProviders();
    await authedGet("/orgs/stats?type=broadcast&brandId=b1&campaignIds=camp_a, camp_b,camp_a");
    const urls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(urls).toHaveLength(2);
    expect(urls.map((u) => new URL(u).searchParams.get("campaignId")).sort()).toEqual(["camp_a", "camp_b"]);
    for (const u of urls) {
      expect(u.startsWith("http://localhost:3011/orgs/stats")).toBe(true);
      expect(new URL(u).searchParams.has("campaignIds")).toBe(false);
      expect(new URL(u).searchParams.get("brandId")).toBe("b1");
    }
  });

  it("merges grouped answers per key", async () => {
    routeProviders({ grouped: true });
    const res = await authedGet("/orgs/stats?type=broadcast&groupBy=workflowSlug&campaignIds=camp_a,camp_b,camp_c");
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.groups.map((g: { key: string; broadcast: { recipientStats: { contacted: number } } }) => [g.key, g.broadcast.recipientStats.contacted]));
    expect(byKey).toEqual({ "cold-v1": 333, "cold-v2": 330 });
  });

  it("perCampaign=true carries each row's own answer byte-equal to a campaignId read", async () => {
    routeProviders();
    const single = await authedGet("/orgs/stats?type=broadcast&groupBy=workflowSlug&campaignId=camp_b");
    const res = await authedGet("/orgs/stats?type=broadcast&groupBy=workflowSlug&campaignIds=camp_a,camp_b&perCampaign=true");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.byCampaign)).toEqual(["camp_a", "camp_b"]);
    expect(res.body.byCampaign.camp_b).toEqual(single.body);
  });

  it("fetches the dynasty map once for a dynasty-grouped family read", async () => {
    routeProviders();
    const res = await authedGet("/orgs/stats?type=broadcast&groupBy=workflowDynastySlug&campaignIds=camp_a,camp_b,camp_c");
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([expect.objectContaining({ key: "cold" })]);
    expect(res.body.groups[0].broadcast.recipientStats.contacted).toBe(333 + 330);
    const dynastyCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("/workflows/dynasties"));
    expect(dynastyCalls).toHaveLength(1);
  });

  it("fails the whole read when one row's provider read fails — never a partial sum", async () => {
    routeProviders({ failInstantlyFor: "camp_b" });
    const res = await authedGet("/orgs/stats?campaignIds=camp_a,camp_b,camp_c");
    expect(res.status).toBe(502);
    expect(res.body.details).toContain("instantly-service");
    expect(res.body.broadcast).toBeUndefined();
  });

  it("works on the service-auth public route", async () => {
    routeProviders();
    const res = await request(app).get("/public/stats?type=broadcast&campaignIds=camp_a,camp_c").set("X-API-Key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.broadcast.recipientStats.contacted).toBe(303);
  });

  it.each([
    ["campaignId and campaignIds together", "/orgs/stats?campaignId=camp_a&campaignIds=camp_b"],
    ["perCampaign without campaignIds", "/orgs/stats?perCampaign=true"],
    ["an empty list", "/orgs/stats?campaignIds=,,"],
    ["an unknown perCampaign value", "/orgs/stats?campaignIds=camp_a&perCampaign=yes"],
    ["more than 200 ids", `/orgs/stats?campaignIds=${Array.from({ length: 201 }, (_, i) => `c${i}`).join(",")}`],
  ])("refuses %s with a 400", async (_label, path) => {
    const res = await authedGet(path);
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
