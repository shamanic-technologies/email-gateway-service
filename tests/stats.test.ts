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

function authedGet(path: string) {
  return request(app)
    .get(path)
    .set("X-API-Key", API_KEY)
    .set("x-org-id", "org_1")
    .set("x-user-id", "user_1")
    .set("x-run-id", "run_1");
}

function serviceAuthGet(path: string) {
  return request(app)
    .get(path)
    .set("X-API-Key", API_KEY);
}

const ZERO_DETAIL = { interested: 0, meetingBooked: 0, closed: 0, notInterested: 0, wrongPerson: 0, unsubscribe: 0, neutral: 0, autoReply: 0, outOfOffice: 0 };

function mockPostmarkStats(recipientOverrides = {}, emailOverrides = {}) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        recipientStats: {
          contacted: 100, sent: 100, delivered: 95, opened: 40, bounced: 3, clicked: 10, unsubscribed: 0,
          repliesPositive: 3, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 1,
          repliesDetail: { ...ZERO_DETAIL, interested: 2, meetingBooked: 1, outOfOffice: 1, unsubscribe: 2 },
          ...recipientOverrides,
        },
        emailStats: {
          sent: 100, delivered: 95, opened: 40, clicked: 10, bounced: 3, unsubscribed: 0,
          ...emailOverrides,
        },
      }),
  };
}

function mockInstantlyStats(recipientOverrides = {}, emailOverrides = {}, stepStats?: Array<Record<string, unknown>>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        recipientStats: {
          contacted: 85, sent: 75, delivered: 70, opened: 30, bounced: 5, clicked: 3, unsubscribed: 0,
          repliesPositive: 0, repliesNegative: 1, repliesNeutral: 0, repliesAutoReply: 2,
          repliesDetail: { ...ZERO_DETAIL, notInterested: 1, outOfOffice: 2 },
          ...recipientOverrides,
        },
        emailStats: {
          sent: 80, delivered: 75, opened: 30, clicked: 3, bounced: 5, unsubscribed: 0,
          ...(stepStats ? { stepStats } : {}),
          ...emailOverrides,
        },
      }),
  };
}

function mockGroupedPostmark(groups: Array<{ key: string; recipientOverrides?: Record<string, unknown>; emailOverrides?: Record<string, unknown> }>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        groups: groups.map((g) => ({
          key: g.key,
          recipientStats: {
            contacted: 50, sent: 50, delivered: 45, opened: 20, bounced: 1, clicked: 5, unsubscribed: 0,
            repliesPositive: 1, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0,
            repliesDetail: { ...ZERO_DETAIL, interested: 1 },
            ...g.recipientOverrides,
          },
          emailStats: {
            sent: 50, delivered: 45, opened: 20, clicked: 5, bounced: 1, unsubscribed: 0,
            ...g.emailOverrides,
          },
        })),
      }),
  };
}

function mockGroupedInstantly(groups: Array<{ key: string; recipientOverrides?: Record<string, unknown>; emailOverrides?: Record<string, unknown> }>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        groups: groups.map((g) => ({
          key: g.key,
          recipientStats: {
            contacted: 42, sent: 35, delivered: 33, opened: 15, bounced: 2, clicked: 2, unsubscribed: 0,
            repliesPositive: 0, repliesNegative: 1, repliesNeutral: 0, repliesAutoReply: 1,
            repliesDetail: { ...ZERO_DETAIL, notInterested: 1, outOfOffice: 1 },
            ...g.recipientOverrides,
          },
          emailStats: {
            sent: 40, delivered: 38, opened: 15, clicked: 2, bounced: 2, unsubscribed: 0,
            ...g.emailOverrides,
          },
        })),
      }),
  };
}

function mockEngagementLatencyGroups(groups: Array<{
  key: string;
  workflowSlugs?: string[];
  timeToFirstLinkClick: { averageMs: number | null; medianMs: number | null; sampleSize: number };
  timeToFirstPositiveReply: { averageMs: number | null; medianMs: number | null; sampleSize: number };
  extra?: Record<string, unknown>;
}>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        groups: groups.map((group) => ({
          key: group.key,
          workflowSlugs: group.workflowSlugs ?? [group.key],
          timeToFirstLinkClick: group.timeToFirstLinkClick,
          timeToFirstPositiveReply: group.timeToFirstPositiveReply,
          ...group.extra,
        })),
      }),
  };
}

describe("GET /orgs/stats", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/orgs/stats");
    expect(res.status).toBe(401);
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const res = await request(app)
      .get("/orgs/stats")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("works without x-user-id header (optional)", async () => {
    mockFetch.mockResolvedValueOnce(mockPostmarkStats());
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    const res = await request(app)
      .get("/orgs/stats")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_1");

    expect(res.status).toBe(200);
  });

  it("works without x-run-id header (optional)", async () => {
    mockFetch.mockResolvedValueOnce(mockPostmarkStats());
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    const res = await request(app)
      .get("/orgs/stats")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_1")
      .set("x-user-id", "user_1");

    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid type query param", async () => {
    const res = await authedGet("/orgs/stats?type=invalid");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  describe("type: transactional", () => {
    it("returns transactional channel stats from Postmark", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      const res = await authedGet("/orgs/stats?type=transactional");

      expect(res.status).toBe(200);
      expect(res.body.transactional.recipientStats).toEqual({
        contacted: 100, sent: 100, delivered: 95, opened: 40, bounced: 3, clicked: 10, unsubscribed: 0,
        repliesPositive: 3, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 1,
        repliesDetail: { ...ZERO_DETAIL, interested: 2, meetingBooked: 1, outOfOffice: 1, unsubscribe: 2 },
      });
      expect(res.body.transactional.emailStats).toEqual({
        sent: 100, delivered: 95, opened: 40, clicked: 10, bounced: 3, unsubscribed: 0,
      });
      expect(res.body.broadcast).toBeUndefined();
    });

    it("passes filters to Postmark (orgId/userId from headers)", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/orgs/stats?type=transactional&campaignId=camp_1");

      const [fetchUrl] = mockFetch.mock.calls[0];
      const params = new URL(fetchUrl).searchParams;
      expect(fetchUrl).toContain("http://localhost:3010/orgs/stats?");
      expect(params.get("orgId")).toBe("org_1");
      expect(params.get("userId")).toBe("user_1");
      expect(params.get("campaignId")).toBe("camp_1");
      expect(params.has("type")).toBe(false);
    });

    it("forwards identity headers to postmark-service", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/orgs/stats?type=transactional");

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-org-id"]).toBe("org_1");
      expect(headers["x-user-id"]).toBe("user_1");
      expect(headers["x-run-id"]).toBe("run_1");
    });
  });

  describe("type: broadcast", () => {
    it("returns broadcast channel stats from Instantly", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await authedGet("/orgs/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast.recipientStats).toEqual({
        contacted: 85, sent: 75, delivered: 70, opened: 30, bounced: 5, clicked: 3, unsubscribed: 0,
        repliesPositive: 0, repliesNegative: 1, repliesNeutral: 0, repliesAutoReply: 2,
        repliesDetail: { ...ZERO_DETAIL, notInterested: 1, outOfOffice: 2 },
      });
      expect(res.body.broadcast.emailStats).toEqual({
        sent: 80, delivered: 75, opened: 30, clicked: 3, bounced: 5, unsubscribed: 0,
      });
      expect(res.body.transactional).toBeUndefined();
    });

    it("passes filters to Instantly (orgId/userId from headers)", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      await authedGet("/orgs/stats?type=broadcast");

      const [fetchUrl] = mockFetch.mock.calls[0];
      const params = new URL(fetchUrl).searchParams;
      expect(fetchUrl).toContain("http://localhost:3011/orgs/stats?");
      expect(params.get("orgId")).toBe("org_1");
      expect(params.get("userId")).toBe("user_1");
      expect(params.has("type")).toBe(false);
    });

    it("forwards identity headers to instantly-service", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      await authedGet("/orgs/stats?type=broadcast");

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-org-id"]).toBe("org_1");
      expect(headers["x-user-id"]).toBe("user_1");
      expect(headers["x-run-id"]).toBe("run_1");
    });
  });

  describe("aggregate (no type)", () => {
    it("returns both transactional and broadcast stats", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailStats.sent).toBe(100);
      expect(res.body.broadcast.emailStats.sent).toBe(80);
    });

    it("returns error for broadcast when Instantly fails", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011"))
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Instantly down"),
          });
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailStats.sent).toBe(100);
      expect(res.body.broadcast.error).toBeDefined();
    });

    it("returns error for transactional when Postmark fails", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010"))
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Postmark down"),
          });
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.error).toBeDefined();
      expect(res.body.broadcast.emailStats.sent).toBe(80);
    });

    it("returns errors for both when both fail", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010"))
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Postmark down"),
          });
        if (url.includes("3011"))
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Instantly down"),
          });
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.error).toBeDefined();
      expect(res.body.broadcast.error).toBeDefined();
    });
  });

  describe("pass-through shape", () => {
    it("passes through recipientStats and emailStats from provider", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await authedGet("/orgs/stats?type=broadcast");

      expect(res.body.broadcast.recipientStats.contacted).toBe(85);
      expect(res.body.broadcast.recipientStats.sent).toBe(75);
      expect(res.body.broadcast.emailStats.sent).toBe(80);
    });

    it("passes through reply buckets and detail as-is from provider", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await authedGet("/orgs/stats?type=broadcast");

      expect(res.body.broadcast.recipientStats.repliesPositive).toBe(0);
      expect(res.body.broadcast.recipientStats.repliesNegative).toBe(1);
      expect(res.body.broadcast.recipientStats.repliesNeutral).toBe(0);
      expect(res.body.broadcast.recipientStats.repliesAutoReply).toBe(2);
      expect(res.body.broadcast.recipientStats.repliesDetail).toEqual({ ...ZERO_DETAIL, notInterested: 1, outOfOffice: 2 });
    });

    it("passes through repliesDetail.interested correctly", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats({
        repliesPositive: 1,
        repliesNeutral: 0,
        repliesDetail: { ...ZERO_DETAIL, interested: 1 },
      }));

      const res = await authedGet("/orgs/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast.recipientStats.repliesPositive).toBe(1);
      expect(res.body.broadcast.recipientStats.repliesDetail.interested).toBe(1);
      expect(res.body.broadcast.recipientStats.repliesNeutral).toBe(0);
    });
  });

  describe("tracking headers (x-campaign-id, x-brand-id, x-workflow-slug, x-feature-slug)", () => {
    it("forwards tracking headers to downstream providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error("Unexpected URL"));
      });

      await authedGet("/orgs/stats")
        .set("x-campaign-id", "camp_hdr")
        .set("x-brand-id", "brand_hdr")
        .set("x-workflow-slug", "wf_hdr")
        .set("x-feature-slug", "feat_hdr");

      for (const call of mockFetch.mock.calls) {
        const headers = call[1].headers;
        expect(headers["x-campaign-id"]).toBe("camp_hdr");
        expect(headers["x-brand-id"]).toBe("brand_hdr");
        expect(headers["x-workflow-slug"]).toBe("wf_hdr");
        expect(headers["x-feature-slug"]).toBe("feat_hdr");
      }
    });

    it("works without tracking headers (no breakage)", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/orgs/stats?type=transactional");

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-campaign-id"]).toBeUndefined();
      expect(headers["x-brand-id"]).toBeUndefined();
      expect(headers["x-workflow-slug"]).toBeUndefined();
      expect(headers["x-feature-slug"]).toBeUndefined();
    });
  });

  describe("filters", () => {
    it("passes workflowSlugs to provider", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/orgs/stats?type=transactional&workflowSlugs=welcome-flow");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("workflowSlugs")).toBe("welcome-flow");
    });

    it("passes brandId to provider", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/orgs/stats?type=transactional&brandId=brand_1");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("brandId")).toBe("brand_1");
    });

    it("parses comma-separated workflowSlugs and forwards to provider", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockGroupedPostmark([{ key: "wf1" }, { key: "wf2" }]));
        if (url.includes("3011")) return Promise.resolve(mockGroupedInstantly([{ key: "wf1" }, { key: "wf2" }]));
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats?groupBy=workflowSlug&workflowSlugs=wf1,wf2");

      expect(res.status).toBe(200);
      for (const call of mockFetch.mock.calls) {
        const params = new URL(call[0]).searchParams;
        expect(params.get("workflowSlugs")).toBe("wf1,wf2");
      }
    });

    it("trims whitespace in workflowSlugs", async () => {
      mockFetch.mockResolvedValueOnce(mockGroupedPostmark([{ key: "wf1" }]));

      await authedGet("/orgs/stats?type=transactional&groupBy=workflowSlug&workflowSlugs= wf1 , wf2 ");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("workflowSlugs")).toBe("wf1,wf2");
    });

    it("parses comma-separated featureSlugs and forwards to provider", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockGroupedPostmark([{ key: "sales-cold-email" }, { key: "sales-cold-email-v2" }]));
        if (url.includes("3011")) return Promise.resolve(mockGroupedInstantly([{ key: "sales-cold-email" }, { key: "sales-cold-email-v2" }]));
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats?groupBy=featureSlug&featureSlugs=sales-cold-email,sales-cold-email-v2");

      expect(res.status).toBe(200);
      for (const call of mockFetch.mock.calls) {
        const params = new URL(call[0]).searchParams;
        expect(params.get("featureSlugs")).toBe("sales-cold-email,sales-cold-email-v2");
      }
    });

    it("trims whitespace in featureSlugs", async () => {
      mockFetch.mockResolvedValueOnce(mockGroupedPostmark([{ key: "f1" }]));

      await authedGet("/orgs/stats?type=transactional&groupBy=featureSlug&featureSlugs= f1 , f2 ");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("featureSlugs")).toBe("f1,f2");
    });

    it("forwards featureSlugs on /public/stats without identity headers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await serviceAuthGet("/public/stats?featureSlugs=sales-cold-email,sales-cold-email-v2&groupBy=workflowSlug");

      expect(res.status).toBe(200);
      for (const call of mockFetch.mock.calls) {
        const params = new URL(call[0]).searchParams;
        expect(params.get("featureSlugs")).toBe("sales-cold-email,sales-cold-email-v2");
      }
    });

    it("parses comma-separated runIds and forwards to provider", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/orgs/stats?type=transactional&runIds=run_a,run_b,run_c");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("runIds")).toBe("run_a,run_b,run_c");
    });

    it("forwards explicit customer persona/profile filters to providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error("Unexpected URL"));
      });

      await authedGet("/orgs/stats?customerPersonaId=persona_1&customerProfileId=profile_1&brandId=brand_1&featureSlugs=feat_1");

      for (const call of mockFetch.mock.calls) {
        const params = new URL(call[0]).searchParams;
        expect(params.get("customerPersonaId")).toBe("persona_1");
        expect(params.get("customerProfileId")).toBe("profile_1");
        expect(params.get("brandId")).toBe("brand_1");
        expect(params.get("featureSlugs")).toBe("feat_1");
      }
    });
  });

  describe("groupBy", () => {
    it("returns grouped broadcast stats from a single provider", async () => {
      mockFetch.mockResolvedValueOnce(
        mockGroupedInstantly([
          { key: "brand_1" },
          { key: "brand_2" },
        ])
      );

      const res = await authedGet("/orgs/stats?type=broadcast&groupBy=brandId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      expect(res.body.groups[0].key).toBe("brand_1");
      expect(res.body.groups[0].broadcast.emailStats.sent).toBe(40);
      expect(res.body.groups[0].broadcast.recipientStats.sent).toBe(35);
      expect(res.body.groups[0].transactional).toBeUndefined();
      expect(res.body.groups[1].key).toBe("brand_2");
    });

    it("returns grouped transactional stats from a single provider", async () => {
      mockFetch.mockResolvedValueOnce(
        mockGroupedPostmark([
          { key: "camp_1" },
          { key: "camp_2" },
        ])
      );

      const res = await authedGet("/orgs/stats?type=transactional&groupBy=campaignId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      expect(res.body.groups[0].key).toBe("camp_1");
      expect(res.body.groups[0].transactional.emailStats.sent).toBe(50);
      expect(res.body.groups[0].broadcast).toBeUndefined();
    });

    it("merges groups from both providers by key", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010"))
          return Promise.resolve(
            mockGroupedPostmark([
              { key: "brand_1" },
              { key: "brand_2" },
            ])
          );
        if (url.includes("3011"))
          return Promise.resolve(
            mockGroupedInstantly([
              { key: "brand_1" },
              { key: "brand_3" },
            ])
          );
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats?groupBy=brandId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(3);

      const byKey = new Map(res.body.groups.map((g: { key: string }) => [g.key, g]));

      const brand1 = byKey.get("brand_1");
      expect(brand1.transactional.emailStats.sent).toBe(50);
      expect(brand1.broadcast.emailStats.sent).toBe(40);

      const brand2 = byKey.get("brand_2");
      expect(brand2.transactional.emailStats.sent).toBe(50);
      expect(brand2.broadcast).toBeUndefined();

      const brand3 = byKey.get("brand_3");
      expect(brand3.transactional).toBeUndefined();
      expect(brand3.broadcast.emailStats.sent).toBe(40);
    });

    it("passes groupBy to providers in query params", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010"))
          return Promise.resolve(mockGroupedPostmark([{ key: "wf_1" }]));
        if (url.includes("3011"))
          return Promise.resolve(mockGroupedInstantly([{ key: "wf_1" }]));
        return Promise.reject(new Error("Unexpected URL"));
      });

      await authedGet("/orgs/stats?groupBy=workflowSlug");

      for (const call of mockFetch.mock.calls) {
        const params = new URL(call[0]).searchParams;
        expect(params.get("groupBy")).toBe("workflowSlug");
      }
    });

    it("passes through distinct customer persona groups without changing provider counts", async () => {
      mockFetch.mockResolvedValueOnce(
        mockGroupedInstantly([
          {
            key: "persona_a",
            recipientOverrides: { clicked: 4, repliesPositive: 2, repliesDetail: { ...ZERO_DETAIL, interested: 2 } },
            emailOverrides: { clicked: 5 },
          },
          {
            key: "persona_b",
            recipientOverrides: { clicked: 1, repliesPositive: 0, repliesDetail: { ...ZERO_DETAIL } },
            emailOverrides: { clicked: 1 },
          },
        ])
      );

      const res = await authedGet("/orgs/stats?type=broadcast&brandId=brand_1&featureSlugs=active_goal_feature&groupBy=customerPersonaId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);

      const byKey = new Map(res.body.groups.map((g: { key: string }) => [g.key, g]));
      expect(byKey.get("persona_a").broadcast.recipientStats.clicked).toBe(4);
      expect(byKey.get("persona_a").broadcast.recipientStats.repliesPositive).toBe(2);
      expect(byKey.get("persona_a").broadcast.emailStats.clicked).toBe(5);
      expect(byKey.get("persona_b").broadcast.recipientStats.clicked).toBe(1);
      expect(byKey.get("persona_b").broadcast.recipientStats.repliesPositive).toBe(0);

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("groupBy")).toBe("customerPersonaId");
      expect(params.get("brandId")).toBe("brand_1");
      expect(params.get("featureSlugs")).toBe("active_goal_feature");
    });

    it("keeps untagged customer persona outcomes unattributed instead of creating a fallback row", async () => {
      mockFetch.mockResolvedValueOnce(mockGroupedInstantly([]));

      const res = await authedGet("/orgs/stats?type=broadcast&brandId=brand_1&featureSlugs=active_goal_feature&groupBy=customerPersonaId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });

    it("forwards day grouping and timezone to Instantly for broadcast stats", async () => {
      mockFetch.mockResolvedValueOnce(
        mockGroupedInstantly([
          { key: "2026-06-10", emailOverrides: { sent: 12 } },
          { key: "2026-06-11", emailOverrides: { sent: 28 } },
        ])
      );

      const res = await authedGet(
        "/orgs/stats?type=broadcast&groupBy=day&brandId=brand_1&campaignId=camp_1&workflowSlugs=wf1,wf2&featureSlugs=feat1,feat2&timezone=Asia/Kuala_Lumpur"
      );

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      expect(res.body.groups[0].key).toBe("2026-06-10");
      expect(res.body.groups[0].broadcast.emailStats.sent).toBe(12);
      expect(res.body.groups[0].transactional).toBeUndefined();

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("groupBy")).toBe("day");
      expect(params.get("timezone")).toBe("Asia/Kuala_Lumpur");
      expect(params.get("brandId")).toBe("brand_1");
      expect(params.get("campaignId")).toBe("camp_1");
      expect(params.get("workflowSlugs")).toBe("wf1,wf2");
      expect(params.get("featureSlugs")).toBe("feat1,feat2");
    });

    it("returns broadcast-only groups for day grouping when type is omitted", async () => {
      mockFetch.mockResolvedValueOnce(
        mockGroupedInstantly([{ key: "2026-06-12" }])
      );

      const res = await authedGet("/orgs/stats?groupBy=day&brandId=brand_1&timezone=Europe/Paris");

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain("http://localhost:3011/orgs/stats");
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].broadcast.emailStats.sent).toBe(40);
      expect(res.body.groups[0].transactional).toBeUndefined();
    });

    it("does not query transactional provider or fabricate buckets for transactional day grouping", async () => {
      const res = await authedGet("/orgs/stats?type=transactional&groupBy=day&timezone=Europe/Paris");

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns groups from successful provider when other fails (grouped mode)", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010"))
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Postmark down"),
          });
        if (url.includes("3011"))
          return Promise.resolve(
            mockGroupedInstantly([{ key: "brand_1" }])
          );
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats?groupBy=brandId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].key).toBe("brand_1");
      expect(res.body.groups[0].broadcast.emailStats.sent).toBe(40);
      expect(res.body.groups[0].transactional).toBeUndefined();
    });

    it("passes through grouped reply buckets as-is from provider", async () => {
      mockFetch.mockResolvedValueOnce(
        mockGroupedInstantly([{ key: "lead@example.com" }])
      );

      const res = await authedGet("/orgs/stats?type=broadcast&groupBy=recipientEmail");

      expect(res.status).toBe(200);
      const group = res.body.groups[0];
      expect(group.broadcast.recipientStats.repliesPositive).toBe(0);
      expect(group.broadcast.recipientStats.repliesNegative).toBe(1);
      expect(group.broadcast.recipientStats.repliesNeutral).toBe(0);
      expect(group.broadcast.recipientStats.repliesAutoReply).toBe(1);
      expect(group.broadcast.recipientStats.repliesDetail).toEqual({ ...ZERO_DETAIL, notInterested: 1, outOfOffice: 1 });
    });

    it("returns empty groups when both providers fail (grouped mode)", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010"))
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Postmark down"),
          });
        if (url.includes("3011"))
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Instantly down"),
          });
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats?groupBy=brandId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });
  });

  describe("fetch retry on network error", () => {
    it("retries once on network error then succeeds", async () => {
      let callCount = 0;
      mockFetch.mockImplementation((url: string) => {
        callCount++;
        if (url.includes("3011")) {
          if (callCount === 1) return Promise.reject(new Error("fetch failed"));
          return Promise.resolve(mockInstantlyStats());
        }
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast.emailStats.sent).toBe(80);
      expect(callCount).toBe(2);
    });

    it("includes URL in error after retries exhausted", async () => {
      mockFetch.mockRejectedValue(new Error("fetch failed"));

      const res = await authedGet("/orgs/stats?type=broadcast");

      expect(res.status).toBe(502);
      expect(res.body.details).toContain("fetch failed");
      expect(res.body.details).toContain("http://localhost:3011");
    });

    it("does not retry on HTTP errors (non-network)", async () => {
      let callCount = 0;
      mockFetch.mockImplementation((url: string) => {
        callCount++;
        if (url.includes("3011"))
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Internal error"),
          });
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats?type=broadcast");

      expect(res.status).toBe(502);
      expect(callCount).toBe(1);
    });

    it("retries network errors in aggregate mode and succeeds on retry", async () => {
      const fetchCalls: string[] = [];
      mockFetch.mockImplementation((url: string) => {
        fetchCalls.push(url);
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) {
          const instantlyCalls = fetchCalls.filter((u) => u.includes("3011"));
          if (instantlyCalls.length === 1) return Promise.reject(new Error("fetch failed"));
          return Promise.resolve(mockInstantlyStats());
        }
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailStats.sent).toBe(100);
      expect(res.body.broadcast.emailStats.sent).toBe(80);
    });
  });

  describe("stepStats (broadcast only)", () => {
    it("forwards stepStats from instantly in broadcast emailStats", async () => {
      const providerSteps = [
        { step: 1, sent: 10, delivered: 9, opened: 8, bounced: 1, clicked: 0, unsubscribed: 0, repliesPositive: 1, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0, repliesDetail: { ...ZERO_DETAIL, interested: 1 } },
        { step: 2, sent: 10, delivered: 9, opened: 5, bounced: 1, clicked: 0, unsubscribed: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 1, repliesAutoReply: 0, repliesDetail: { ...ZERO_DETAIL, neutral: 1 } },
        { step: 3, sent: 10, delivered: 10, opened: 2, bounced: 0, clicked: 0, unsubscribed: 0, repliesPositive: 0, repliesNegative: 1, repliesNeutral: 0, repliesAutoReply: 0, repliesDetail: { ...ZERO_DETAIL, notInterested: 1 } },
      ];
      mockFetch.mockResolvedValueOnce(mockInstantlyStats({}, { stepStats: providerSteps }));

      const res = await authedGet("/orgs/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast.emailStats.stepStats).toEqual(providerSteps);
      expect(res.body.broadcast.emailStats.sent).toBe(80);
    });

    it("omits stepStats when not present in provider response", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await authedGet("/orgs/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast.emailStats.stepStats).toBeUndefined();
      expect(res.body.broadcast.emailStats.sent).toBe(80);
    });

    it("includes stepStats in broadcast emailStats when aggregating both providers", async () => {
      const providerSteps = [
        { step: 1, sent: 10, delivered: 9, opened: 8, bounced: 1, clicked: 0, unsubscribed: 0, repliesPositive: 1, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0, repliesDetail: { ...ZERO_DETAIL, interested: 1 } },
      ];
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats({}, { stepStats: providerSteps }));
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/orgs/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailStats.stepStats).toBeUndefined();
      expect(res.body.broadcast.emailStats.stepStats).toEqual(providerSteps);
    });
  });

  describe("dynasty slug filters", () => {
    it("resolves workflowDynastySlug to workflowSlugs and forwards to providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasty/slugs"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ workflowDynastySlug: "cold-email", workflowDynastyName: "Cold Email", workflowSlugs: ["cold-email", "cold-email-v2"] }),
          });
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?workflowDynastySlug=cold-email");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailStats.sent).toBe(100);
      expect(res.body.broadcast.emailStats.sent).toBe(80);

      // Verify providers got workflowSlugs, not workflowDynastySlug
      const providerCalls = mockFetch.mock.calls.filter(
        (c) => c[0].includes("3010") || c[0].includes("3011")
      );
      for (const call of providerCalls) {
        const params = new URL(call[0]).searchParams;
        expect(params.get("workflowSlugs")).toBe("cold-email,cold-email-v2");
        expect(params.has("workflowDynastySlug")).toBe(false);
      }
    });

    it("resolves featureDynastySlug to featureSlugs and forwards to providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("features:3020") && url.includes("/features/dynasty/slugs"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ slugs: ["feat-a", "feat-a-v2"] }),  // features-service uses generic shape
          });
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?featureDynastySlug=feat-a");

      expect(res.status).toBe(200);
      const providerCalls = mockFetch.mock.calls.filter(
        (c) => c[0].includes("3010") || c[0].includes("3011")
      );
      for (const call of providerCalls) {
        const params = new URL(call[0]).searchParams;
        expect(params.get("featureSlugs")).toBe("feat-a,feat-a-v2");
        expect(params.has("featureDynastySlug")).toBe(false);
      }
    });

    it("returns zero stats when workflowDynastySlug resolves to empty", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasty/slugs"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ workflowDynastySlug: "nonexistent", workflowDynastyName: "", workflowSlugs: [] }),
          });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?workflowDynastySlug=nonexistent");

      expect(res.status).toBe(200);
      expect(res.body.transactional.recipientStats.sent).toBe(0);
      expect(res.body.broadcast.recipientStats.sent).toBe(0);
      // Should NOT call providers at all
      const providerCalls = mockFetch.mock.calls.filter(
        (c) => c[0].includes("3010") || c[0].includes("3011")
      );
      expect(providerCalls).toHaveLength(0);
    });

    it("returns zero stats for single type when dynasty resolves to empty", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("features:3020") && url.includes("/features/dynasty/slugs"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ slugs: [] }),
          });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?type=transactional&featureDynastySlug=empty");

      expect(res.status).toBe(200);
      expect(res.body.transactional.recipientStats.sent).toBe(0);
      expect(res.body.broadcast).toBeUndefined();
    });

    it("returns empty groups when dynasty resolves to empty in grouped mode", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasty/slugs"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ workflowDynastySlug: "nonexistent", workflowDynastyName: "", workflowSlugs: [] }),
          });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?groupBy=brandId&workflowDynastySlug=nonexistent");

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });

    it("combines workflowDynastySlug with other filters", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasty/slugs"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ workflowDynastySlug: "wf-1", workflowDynastyName: "WF 1", workflowSlugs: ["wf-1", "wf-1-v2"] }),
          });
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?type=transactional&workflowDynastySlug=wf-1&brandId=brand_1");

      expect(res.status).toBe(200);
      const params = new URL(mockFetch.mock.calls.find((c) => c[0].includes("3010"))![0]).searchParams;
      expect(params.get("workflowSlugs")).toBe("wf-1,wf-1-v2");
      expect(params.get("brandId")).toBe("brand_1");
    });

    it("passes featureSlugs filter directly to providers", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/orgs/stats?type=transactional&featureSlugs=my-feature");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("featureSlugs")).toBe("my-feature");
    });
  });

  describe("dynasty slug groupBy", () => {
    it("regroups by workflowDynastySlug (transactional)", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasties"))
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                dynasties: [
                  { workflowDynastySlug: "cold-email", workflowDynastyName: "Cold Email", workflowSlugs: ["cold-email", "cold-email-v2"] },
                ],
              }),
          });
        if (url.includes("3010"))
          return Promise.resolve(
            mockGroupedPostmark([
              { key: "cold-email", emailOverrides: { sent: 30 } },
              { key: "cold-email-v2", emailOverrides: { sent: 20 } },
            ])
          );
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?type=transactional&groupBy=workflowDynastySlug");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].key).toBe("cold-email");
      // 30 + 20 = 50
      expect(res.body.groups[0].transactional.emailStats.sent).toBe(50);
    });

    it("regroups by featureDynastySlug (broadcast)", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("features:3020") && url.includes("/features/dynasties"))
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                dynasties: [
                  { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
                ],
              }),
          });
        if (url.includes("3011"))
          return Promise.resolve(
            mockGroupedInstantly([
              { key: "feat-alpha", recipientOverrides: { sent: 20 }, emailOverrides: { sent: 25 } },
              { key: "feat-alpha-v2", recipientOverrides: { sent: 10 }, emailOverrides: { sent: 15 } },
            ])
          );
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?type=broadcast&groupBy=featureDynastySlug");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].key).toBe("feat-alpha");
      expect(res.body.groups[0].broadcast.emailStats.sent).toBe(40);
      expect(res.body.groups[0].broadcast.recipientStats.sent).toBe(30);
    });

    it("sends groupBy=workflowSlug to providers when dynasty groupBy requested", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasties"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ dynasties: [] }),
          });
        if (url.includes("3010"))
          return Promise.resolve(mockGroupedPostmark([{ key: "wf-1" }]));
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      await authedGet("/orgs/stats?type=transactional&groupBy=workflowDynastySlug");

      const postmarkCall = mockFetch.mock.calls.find((c) => c[0].includes("3010"));
      const params = new URL(postmarkCall![0]).searchParams;
      expect(params.get("groupBy")).toBe("workflowSlug");
    });

    it("falls back to raw slug for orphan slugs not in any dynasty", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasties"))
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                dynasties: [
                  { workflowDynastySlug: "cold-email", workflowDynastyName: "Cold Email", workflowSlugs: ["cold-email", "cold-email-v2"] },
                ],
              }),
          });
        if (url.includes("3010"))
          return Promise.resolve(
            mockGroupedPostmark([
              { key: "cold-email", emailOverrides: { sent: 30 } },
              { key: "orphan-slug", emailOverrides: { sent: 10 } },
            ])
          );
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?type=transactional&groupBy=workflowDynastySlug");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      const byKey = new Map(res.body.groups.map((g: { key: string }) => [g.key, g]));
      expect(byKey.get("cold-email").transactional.emailStats.sent).toBe(30);
      expect(byKey.get("orphan-slug").transactional.emailStats.sent).toBe(10);
    });

    it("merges dynasty groups from both providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasties"))
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                dynasties: [
                  { workflowDynastySlug: "cold-email", workflowDynastyName: "Cold Email", workflowSlugs: ["cold-email", "cold-email-v2"] },
                ],
              }),
          });
        if (url.includes("3010"))
          return Promise.resolve(
            mockGroupedPostmark([
              { key: "cold-email" },
              { key: "cold-email-v2" },
            ])
          );
        if (url.includes("3011"))
          return Promise.resolve(
            mockGroupedInstantly([
              { key: "cold-email" },
              { key: "cold-email-v2" },
            ])
          );
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/orgs/stats?groupBy=workflowDynastySlug");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].key).toBe("cold-email");
      // Both provider groups merged under same dynasty
      expect(res.body.groups[0].transactional).toBeDefined();
      expect(res.body.groups[0].broadcast).toBeDefined();
      // Transactional: 50 + 50 = 100
      expect(res.body.groups[0].transactional.emailStats.sent).toBe(100);
      // Broadcast: 40 + 40 = 80
      expect(res.body.groups[0].broadcast.emailStats.sent).toBe(80);
    });
  });
});

describe("GET /public/stats", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/public/stats");
    expect(res.status).toBe(401);
  });

  it("succeeds without identity headers", async () => {
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    const res = await serviceAuthGet("/public/stats?type=broadcast");

    expect(res.status).toBe(200);
    expect(res.body.broadcast.emailStats.sent).toBe(80);
  });

  it("calls downstream /stats/public (no ctx) when no identity headers provided", async () => {
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    await serviceAuthGet("/public/stats?type=broadcast");

    const [fetchUrl, options] = mockFetch.mock.calls[0];
    expect(fetchUrl).toContain("http://localhost:3011/public/stats");
    const headers = options.headers;
    expect(headers["x-org-id"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-run-id"]).toBeUndefined();
  });

  it("calls downstream /stats/public (no ctx) for postmark when no identity headers", async () => {
    mockFetch.mockResolvedValueOnce(mockPostmarkStats());

    await serviceAuthGet("/public/stats?type=transactional&brandId=brand_1");

    const [fetchUrl] = mockFetch.mock.calls[0];
    expect(fetchUrl).toContain("http://localhost:3010/internal/stats");
    const params = new URL(fetchUrl).searchParams;
    expect(params.has("orgId")).toBe(false);
    expect(params.has("userId")).toBe(false);
    expect(params.get("brandId")).toBe("brand_1");
  });

  it("returns grouped broadcast stats", async () => {
    mockFetch.mockResolvedValueOnce(
      mockGroupedInstantly([
        { key: "brand_1" },
        { key: "brand_2" },
      ])
    );

    const res = await serviceAuthGet("/public/stats?type=broadcast&groupBy=brandId");

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);
    expect(res.body.groups[0].key).toBe("brand_1");
    expect(res.body.groups[0].broadcast.emailStats.sent).toBe(40);
  });

  it("forwards public day grouping and timezone to Instantly", async () => {
    mockFetch.mockResolvedValueOnce(
      mockGroupedInstantly([{ key: "2026-06-10" }])
    );

    const res = await serviceAuthGet(
      "/public/stats?type=broadcast&groupBy=day&brandId=brand_1&campaignId=camp_1&workflowSlugs=wf1&featureSlugs=feat1&timezone=America/New_York"
    );

    expect(res.status).toBe(200);
    expect(res.body.groups[0].key).toBe("2026-06-10");
    expect(res.body.groups[0].broadcast.emailStats.sent).toBe(40);

    const [fetchUrl, options] = mockFetch.mock.calls[0];
    expect(fetchUrl).toContain("http://localhost:3011/public/stats?");
    const params = new URL(fetchUrl).searchParams;
    expect(params.get("groupBy")).toBe("day");
    expect(params.get("timezone")).toBe("America/New_York");
    expect(params.get("brandId")).toBe("brand_1");
    expect(params.get("campaignId")).toBe("camp_1");
    expect(params.get("workflowSlugs")).toBe("wf1");
    expect(params.get("featureSlugs")).toBe("feat1");
    expect(options.headers["x-org-id"]).toBeUndefined();
  });

  it("keeps existing public stats count behavior backward-compatible", async () => {
    mockFetch.mockResolvedValueOnce(mockGroupedInstantly([{ key: "wf_1" }]));

    const res = await serviceAuthGet("/public/stats?type=broadcast&featureSlugs=sales-cold-email&groupBy=workflowSlug");

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].key).toBe("wf_1");
    expect(res.body.groups[0].broadcast.recipientStats.sent).toBe(35);
    expect(res.body.groups[0].timeToFirstLinkClick).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("http://localhost:3011/public/stats");
  });

  it("calls downstream /stats (not /stats/public) and forwards headers when caller provides identity headers", async () => {
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    await request(app)
      .get("/public/stats?type=broadcast")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_pub")
      .set("x-user-id", "user_pub")
      .set("x-run-id", "run_pub");

    const [fetchUrl, options] = mockFetch.mock.calls[0];
    expect(fetchUrl).toContain("http://localhost:3011/orgs/stats?");
    expect(fetchUrl).not.toContain("/public/stats");
    expect(options.headers["x-org-id"]).toBe("org_pub");
    expect(options.headers["x-user-id"]).toBe("user_pub");
    expect(options.headers["x-run-id"]).toBe("run_pub");
  });

  it("includes orgId/userId in downstream query when caller provides identity headers", async () => {
    mockFetch.mockResolvedValueOnce(mockPostmarkStats());

    await request(app)
      .get("/public/stats?type=transactional")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_pub")
      .set("x-user-id", "user_pub")
      .set("x-run-id", "run_pub");

    const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(params.get("orgId")).toBe("org_pub");
    expect(params.get("userId")).toBe("user_pub");
  });

  it("returns 400 for invalid type", async () => {
    const res = await serviceAuthGet("/public/stats?type=invalid");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("forwards tracking headers from /public/stats route", async () => {
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    await serviceAuthGet("/public/stats?type=broadcast")
      .set("x-campaign-id", "camp_pub")
      .set("x-brand-id", "brand_pub")
      .set("x-workflow-slug", "wf_pub")
      .set("x-feature-slug", "feat_pub");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-campaign-id"]).toBe("camp_pub");
    expect(headers["x-brand-id"]).toBe("brand_pub");
    expect(headers["x-workflow-slug"]).toBe("wf_pub");
    expect(headers["x-feature-slug"]).toBe("feat_pub");
  });

  describe("GET /public/stats/engagement-latency", () => {
    it("returns workflow-grouped public engagement latency from the producer aggregate", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/public/stats/engagement-latency/grouped")) {
          return Promise.resolve(mockEngagementLatencyGroups([
            {
              key: "workflow-a",
              timeToFirstLinkClick: { averageMs: 86_400_000, medianMs: 43_200_000, sampleSize: 4 },
              timeToFirstPositiveReply: { averageMs: 172_800_000, medianMs: 129_600_000, sampleSize: 3 },
            },
            {
              key: "workflow-b",
              timeToFirstLinkClick: { averageMs: 10_000, medianMs: 10_000, sampleSize: 1 },
              timeToFirstPositiveReply: { averageMs: null, medianMs: null, sampleSize: 0 },
            },
          ]));
        }
        if (url.includes("/public/stats")) {
          return Promise.resolve(mockGroupedInstantly([{ key: "workflow-a" }, { key: "workflow-b" }]));
        }
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await serviceAuthGet("/public/stats/engagement-latency?featureSlugs=sales-cold-email&groupBy=workflowSlug");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        groups: [
          {
            key: "workflow-a",
            timeToFirstLinkClick: { averageMs: 86_400_000, medianMs: 43_200_000, sampleSize: 4 },
            timeToFirstPositiveReply: { averageMs: 172_800_000, medianMs: 129_600_000, sampleSize: 3 },
          },
          {
            key: "workflow-b",
            timeToFirstLinkClick: { averageMs: 10_000, medianMs: 10_000, sampleSize: 1 },
            timeToFirstPositiveReply: { averageMs: null, medianMs: null, sampleSize: 0 },
          },
        ],
      });

      const discoveryUrl = new URL(mockFetch.mock.calls[0][0]);
      expect(discoveryUrl.pathname).toBe("/public/stats");
      expect(discoveryUrl.searchParams.get("featureSlugs")).toBe("sales-cold-email");
      expect(discoveryUrl.searchParams.get("groupBy")).toBe("workflowSlug");

      const [latencyUrl, latencyOptions] = mockFetch.mock.calls[1];
      expect(latencyUrl).toBe("http://localhost:3011/public/stats/engagement-latency/grouped");
      expect(latencyOptions.method).toBe("POST");
      expect(JSON.parse(latencyOptions.body)).toEqual({
        groups: {
          "workflow-a": { workflowSlugs: ["workflow-a"] },
          "workflow-b": { workflowSlugs: ["workflow-b"] },
        },
      });
      expect(latencyOptions.headers["x-org-id"]).toBeUndefined();
      expect(latencyOptions.headers["x-user-id"]).toBeUndefined();
      expect(latencyOptions.headers["x-run-id"]).toBeUndefined();
    });

    it("preserves null average and median semantics when sample size is zero", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/public/stats/engagement-latency/grouped")) {
          return Promise.resolve(mockEngagementLatencyGroups([
            {
              key: "workflow-empty",
              timeToFirstLinkClick: { averageMs: null, medianMs: null, sampleSize: 0 },
              timeToFirstPositiveReply: { averageMs: null, medianMs: null, sampleSize: 0 },
            },
          ]));
        }
        if (url.includes("/public/stats")) {
          return Promise.resolve(mockGroupedInstantly([{ key: "workflow-empty" }]));
        }
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await serviceAuthGet("/public/stats/engagement-latency?featureSlugs=sales-cold-email&groupBy=workflowSlug");

      expect(res.status).toBe(200);
      expect(res.body.groups[0].timeToFirstLinkClick).toEqual({ averageMs: null, medianMs: null, sampleSize: 0 });
      expect(res.body.groups[0].timeToFirstPositiveReply).toEqual({ averageMs: null, medianMs: null, sampleSize: 0 });
    });

    it("fails loudly for unsupported groupings", async () => {
      const res = await serviceAuthGet("/public/stats/engagement-latency?featureSlugs=sales-cold-email&groupBy=recipientEmail");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Unsupported groupBy");
      expect(res.body.details).toBe("Only groupBy=workflowSlug is supported");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns no PII or campaign internals from producer responses", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/public/stats/engagement-latency/grouped")) {
          return Promise.resolve(mockEngagementLatencyGroups([
            {
              key: "workflow-safe",
              timeToFirstLinkClick: { averageMs: 1, medianMs: 1, sampleSize: 1 },
              timeToFirstPositiveReply: { averageMs: 2, medianMs: 2, sampleSize: 1 },
              extra: {
                leadEmail: "lead@example.com",
                recipientId: "recipient_1",
                campaignId: "campaign_1",
                campaignName: "Campaign Name",
                orgId: "org_1",
                messageBody: "private",
              },
            },
          ]));
        }
        if (url.includes("/public/stats")) {
          return Promise.resolve(mockGroupedInstantly([{ key: "workflow-safe" }]));
        }
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await serviceAuthGet("/public/stats/engagement-latency?featureSlugs=sales-cold-email&groupBy=workflowSlug");

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.groups[0])).toEqual([
        "key",
        "timeToFirstLinkClick",
        "timeToFirstPositiveReply",
      ]);
      expect(JSON.stringify(res.body)).not.toContain("lead@example.com");
      expect(JSON.stringify(res.body)).not.toContain("campaign_1");
      expect(JSON.stringify(res.body)).not.toContain("private");
    });
  });
});
