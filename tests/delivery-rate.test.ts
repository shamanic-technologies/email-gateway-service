import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { readFileSync } from "fs";
import { join } from "path";
import { app } from "../src/index";
import { deliveryRate, withDeliveryRates } from "../src/lib/delivery-rate";

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

const ZERO_DETAIL = { interested: 0, meetingBooked: 0, closed: 0, notInterested: 0, wrongPerson: 0, unsubscribe: 0, neutral: 0, autoReply: 0, outOfOffice: 0 };

function channel(sent: number, delivered: number) {
  return {
    recipientStats: {
      contacted: sent, sent, delivered, opened: 0, bounced: sent - delivered, clicked: 0, unsubscribed: 0,
      repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0, repliesDetail: ZERO_DETAIL,
    },
    emailStats: { sent, delivered, opened: 0, clicked: 0, bounced: sent - delivered, unsubscribed: 0 },
  };
}

function json(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

function authedGet(path: string) {
  return request(app)
    .get(path)
    .set("X-API-Key", "test-api-key")
    .set("x-org-id", "org_1")
    .set("x-user-id", "user_1")
    .set("x-run-id", "run_1");
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("deliveryRate", () => {
  it("is delivered / sent", () => {
    expect(deliveryRate(531, 518)).toBeCloseTo(0.9755, 4);
    expect(deliveryRate(10, 10)).toBe(1);
    expect(deliveryRate(10, 0)).toBe(0);
  });

  it("is null when nothing was sent — never a division by zero", () => {
    expect(deliveryRate(0, 0)).toBeNull();
  });

  it("is null when delivered exceeds sent — never above 100%, nothing invented", () => {
    expect(deliveryRate(10, 11)).toBeNull();
  });

  it("is recomputed, not trusted, when an object already carries one", () => {
    expect(withDeliveryRates({ sent: 4, delivered: 2, deliveryRate: 3 })).toEqual({ sent: 4, delivered: 2, deliveryRate: 0.5 });
  });

  it("is the first key of the object, so the success figure leads", () => {
    expect(Object.keys(withDeliveryRates({ sent: 4, delivered: 2, bounced: 2 }))[0]).toBe("deliveryRate");
  });
});

describe("stats responses carry deliveryRate at every grain with sent + delivered", () => {
  it("flat, both providers: recipientStats and emailStats of each channel", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(json(url.startsWith("http://localhost:3010") ? channel(100, 95) : channel(531, 518))),
    );
    const res = await authedGet("/orgs/stats");
    expect(res.status).toBe(200);
    expect(res.body.transactional.recipientStats.deliveryRate).toBe(0.95);
    expect(res.body.transactional.emailStats.deliveryRate).toBe(0.95);
    expect(res.body.broadcast.recipientStats.deliveryRate).toBe(518 / 531);
    expect(res.body.broadcast.emailStats.deliveryRate).toBe(518 / 531);
  });

  it("zero sent: deliveryRate is null, counts stay 0", async () => {
    mockFetch.mockResolvedValueOnce(json(channel(0, 0)));
    const res = await authedGet("/orgs/stats?type=broadcast");
    expect(res.status).toBe(200);
    expect(res.body.broadcast.recipientStats).toMatchObject({ sent: 0, delivered: 0, deliveryRate: null });
    expect(res.body.broadcast.emailStats).toMatchObject({ sent: 0, delivered: 0, deliveryRate: null });
  });

  it("empty dynasty short-circuit: the zero body carries null rates", async () => {
    mockFetch.mockResolvedValueOnce(json({ workflowDynastySlug: "x", workflowDynastyName: "X", workflowSlugs: [] }));
    const res = await authedGet("/orgs/stats?type=broadcast&workflowDynastySlug=x");
    expect(res.status).toBe(200);
    expect(res.body.broadcast.recipientStats.deliveryRate).toBeNull();
    expect(res.body.broadcast.emailStats.deliveryRate).toBeNull();
  });

  it("grouped: each group's channel stats", async () => {
    mockFetch.mockResolvedValueOnce(json({ groups: [{ key: "a", ...channel(4, 3) }, { key: "b", ...channel(0, 0) }] }));
    const res = await authedGet("/orgs/stats?type=broadcast&groupBy=campaignId");
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.groups.map((g: { key: string; broadcast: { recipientStats: { deliveryRate: number | null } } }) => [g.key, g.broadcast.recipientStats.deliveryRate]));
    expect(byKey).toEqual({ a: 0.75, b: null });
  });

  it("campaign family: rate of the summed counts (not a sum or mean of row rates), and per row in byCampaign", async () => {
    const rows: Record<string, [number, number]> = { camp_a: [10, 10], camp_b: [90, 45] };
    mockFetch.mockImplementation((url: string) => {
      const [sent, delivered] = rows[new URL(url).searchParams.get("campaignId") ?? ""];
      return Promise.resolve(json(channel(sent, delivered)));
    });
    const res = await authedGet("/orgs/stats?type=broadcast&campaignIds=camp_a,camp_b&perCampaign=true");
    expect(res.status).toBe(200);
    expect(res.body.broadcast.recipientStats).toMatchObject({ sent: 100, delivered: 55, deliveryRate: 0.55 });
    expect(res.body.byCampaign.camp_a.broadcast.recipientStats.deliveryRate).toBe(1);
    expect(res.body.byCampaign.camp_b.broadcast.recipientStats.deliveryRate).toBe(0.5);
  });

  it("per-operation read: the transactional block", async () => {
    mockFetch.mockResolvedValueOnce(json({
      operationRunId: "op_1", matched: true, messagesMatched: 8, recipientsMatched: 8,
      firstMessageAt: null, lastMessageAt: null, ...channel(8, 6),
    }));
    const res = await authedGet("/orgs/stats/by-operation?operationRunId=op_1");
    expect(res.status).toBe(200);
    expect(res.body.transactional.recipientStats.deliveryRate).toBe(0.75);
    expect(res.body.transactional.emailStats.deliveryRate).toBe(0.75);
  });
});

describe("openapi", () => {
  it("documents deliveryRate on the served stats shapes", () => {
    const doc = readFileSync(join(__dirname, "..", "openapi.json"), "utf8");
    const spec = JSON.parse(doc);
    const channelStats = spec.components.schemas.StatsResponse.properties.transactional;
    expect(channelStats.properties.recipientStats.properties.deliveryRate).toBeDefined();
    expect(channelStats.properties.recipientStats.required).toContain("deliveryRate");
    expect(channelStats.properties.emailStats.properties.deliveryRate).toBeDefined();
    expect(channelStats.properties.emailStats.properties.stepStats.items.properties.deliveryRate).toBeDefined();
  });
});
