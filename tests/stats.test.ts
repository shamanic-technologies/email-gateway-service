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

function mockPostmarkStats(overrides = {}) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        stats: {
          emailsContacted: 100,
          emailsSent: 100,
          emailsDelivered: 95,
          emailsOpened: 40,
          emailsClicked: 10,
          emailsReplied: 5,
          emailsBounced: 3,
          repliesWillingToMeet: 1,
          repliesInterested: 2,
          repliesNotInterested: 0,
          repliesOutOfOffice: 1,
          repliesUnsubscribe: 2,
          ...overrides,
        },
      }),
  };
}

function mockInstantlyStats(overrides = {}, stepStats?: Array<{ step: number; emailsSent: number; emailsOpened: number; emailsReplied: number; emailsBounced: number }>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        stats: {
          emailsContacted: 85,
          emailsSent: 80,
          emailsDelivered: 75,
          emailsOpened: 30,
          emailsClicked: 3,
          emailsReplied: 2,
          emailsBounced: 5,
          repliesAutoReply: 2,
          repliesNotInterested: 1,
          repliesOutOfOffice: 2,
          repliesUnsubscribe: 0,
          ...overrides,
        },
        recipients: 75,
        ...(stepStats ? { stepStats } : {}),
      }),
  };
}

function mockGroupedPostmark(groups: Array<{ key: string; overrides?: Record<string, unknown>; recipients?: number }>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        groups: groups.map((g) => ({
          key: g.key,
          stats: {
            emailsContacted: 50,
            emailsSent: 50,
            emailsDelivered: 45,
            emailsOpened: 20,
            emailsClicked: 5,
            emailsReplied: 2,
            emailsBounced: 1,
            repliesWillingToMeet: 1,
            repliesInterested: 1,
            repliesNotInterested: 0,
            repliesOutOfOffice: 0,
            repliesUnsubscribe: 0,
            ...g.overrides,
          },
          recipients: g.recipients,
        })),
      }),
  };
}

function mockGroupedInstantly(groups: Array<{ key: string; overrides?: Record<string, unknown>; recipients?: number }>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        groups: groups.map((g) => ({
          key: g.key,
          stats: {
            emailsContacted: 42,
            emailsSent: 40,
            emailsDelivered: 38,
            emailsOpened: 15,
            emailsClicked: 2,
            emailsReplied: 1,
            emailsBounced: 2,
            repliesNotInterested: 1,
            repliesOutOfOffice: 1,
            repliesUnsubscribe: 0,
            ...g.overrides,
          },
          recipients: g.recipients ?? 35,
        })),
      }),
  };
}

describe("GET /stats", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/stats");
    expect(res.status).toBe(401);
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const res = await request(app)
      .get("/stats")
      .set("X-API-Key", API_KEY)
      .set("x-user-id", "user_1")
      .set("x-run-id", "run_1");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("returns 400 when x-user-id header is missing", async () => {
    const res = await request(app)
      .get("/stats")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_1")
      .set("x-run-id", "run_1");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-user-id");
  });

  it("returns 400 when x-run-id header is missing", async () => {
    const res = await request(app)
      .get("/stats")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_1")
      .set("x-user-id", "user_1");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-run-id");
  });

  it("returns 400 for invalid type query param", async () => {
    const res = await authedGet("/stats?type=invalid");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  describe("type: transactional", () => {
    it("returns normalized transactional stats from Postmark", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      const res = await authedGet("/stats?type=transactional");

      expect(res.status).toBe(200);
      expect(res.body.transactional).toEqual({
        emailsContacted: 100,
        emailsSent: 100,
        emailsDelivered: 95,
        emailsOpened: 40,
        emailsClicked: 10,
        emailsReplied: 5,
        emailsBounced: 3,
        repliesWillingToMeet: 1,
        repliesInterested: 2,
        repliesNotInterested: 0,
        repliesOutOfOffice: 1,
        repliesUnsubscribe: 2,
        recipients: 100,
      });
      expect(res.body.broadcast).toBeUndefined();
    });

    it("passes filters to Postmark (orgId/userId from headers)", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/stats?type=transactional&campaignId=camp_1");

      const [fetchUrl] = mockFetch.mock.calls[0];
      const params = new URL(fetchUrl).searchParams;
      expect(fetchUrl).toContain("http://localhost:3010/stats?");
      expect(params.get("orgId")).toBe("org_1");
      expect(params.get("userId")).toBe("user_1");
      expect(params.get("campaignId")).toBe("camp_1");
      expect(params.has("type")).toBe(false);
    });

    it("forwards identity headers to postmark-service", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/stats?type=transactional");

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-org-id"]).toBe("org_1");
      expect(headers["x-user-id"]).toBe("user_1");
      expect(headers["x-run-id"]).toBe("run_1");
    });
  });

  describe("type: broadcast", () => {
    it("returns normalized broadcast stats from Instantly", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await authedGet("/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast).toEqual({
        emailsContacted: 85,
        emailsSent: 80,
        emailsDelivered: 75,
        emailsOpened: 30,
        emailsClicked: 3,
        emailsReplied: 2,
        emailsBounced: 5,
        repliesWillingToMeet: 0,
        repliesInterested: 0,
        repliesNotInterested: 1,
        repliesOutOfOffice: 2,
        repliesUnsubscribe: 0,
        recipients: 75,
      });
      expect(res.body.transactional).toBeUndefined();
    });

    it("passes filters to Instantly (orgId/userId from headers)", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      await authedGet("/stats?type=broadcast");

      const [fetchUrl] = mockFetch.mock.calls[0];
      const params = new URL(fetchUrl).searchParams;
      expect(fetchUrl).toContain("http://localhost:3011/stats?");
      expect(params.get("orgId")).toBe("org_1");
      expect(params.get("userId")).toBe("user_1");
      expect(params.has("type")).toBe(false);
    });

    it("forwards identity headers to instantly-service", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      await authedGet("/stats?type=broadcast");

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

      const res = await authedGet("/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailsSent).toBe(100);
      expect(res.body.broadcast.emailsSent).toBe(80);
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

      const res = await authedGet("/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailsSent).toBe(100);
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

      const res = await authedGet("/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.error).toBeDefined();
      expect(res.body.broadcast.emailsSent).toBe(80);
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

      const res = await authedGet("/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.error).toBeDefined();
      expect(res.body.broadcast.error).toBeDefined();
    });
  });

  describe("unified normalizer", () => {
    it("uses recipients field when available (Instantly)", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await authedGet("/stats?type=broadcast");

      expect(res.body.broadcast.recipients).toBe(75);
    });

    it("defaults emailsContacted to 0 when field is missing from provider", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            stats: {
              emailsSent: 80,
              emailsDelivered: 75,
              emailsOpened: 30,
              emailsClicked: 3,
              emailsReplied: 2,
              emailsBounced: 5,
            },
            recipients: 75,
          }),
      });

      const res = await authedGet("/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast.emailsContacted).toBe(0);
      expect(res.body.broadcast.emailsSent).toBe(80);
    });

    it("falls back to emailsSent for recipients when field is missing (Postmark)", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      const res = await authedGet("/stats?type=transactional");

      expect(res.body.transactional.recipients).toBe(100);
    });

    it("defaults missing reply subtypes to 0", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await authedGet("/stats?type=broadcast");

      expect(res.body.broadcast.repliesWillingToMeet).toBe(0);
      expect(res.body.broadcast.repliesInterested).toBe(0);
      expect(res.body.broadcast.repliesNotInterested).toBe(1);
      expect(res.body.broadcast.repliesOutOfOffice).toBe(2);
    });
  });

  describe("tracking headers (x-campaign-id, x-brand-id, x-workflow-slug, x-feature-slug)", () => {
    it("forwards tracking headers to downstream providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error("Unexpected URL"));
      });

      await authedGet("/stats")
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

      await authedGet("/stats?type=transactional");

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-campaign-id"]).toBeUndefined();
      expect(headers["x-brand-id"]).toBeUndefined();
      expect(headers["x-workflow-slug"]).toBeUndefined();
      expect(headers["x-feature-slug"]).toBeUndefined();
    });
  });

  describe("filters", () => {
    it("passes workflowSlug to provider", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/stats?type=transactional&workflowSlug=welcome-flow");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("workflowSlug")).toBe("welcome-flow");
    });

    it("passes brandIds to provider", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/stats?type=transactional&brandIds=brand_1");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("brandIds")).toBe("brand_1");
    });

    it("parses comma-separated workflowSlugs and forwards to provider", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockGroupedPostmark([{ key: "wf1" }, { key: "wf2" }]));
        if (url.includes("3011")) return Promise.resolve(mockGroupedInstantly([{ key: "wf1" }, { key: "wf2" }]));
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/stats?groupBy=workflowSlug&workflowSlugs=wf1,wf2");

      expect(res.status).toBe(200);
      for (const call of mockFetch.mock.calls) {
        const params = new URL(call[0]).searchParams;
        expect(params.get("workflowSlugs")).toBe("wf1,wf2");
      }
    });

    it("trims whitespace in workflowSlugs", async () => {
      mockFetch.mockResolvedValueOnce(mockGroupedPostmark([{ key: "wf1" }]));

      await authedGet("/stats?type=transactional&groupBy=workflowSlug&workflowSlugs= wf1 , wf2 ");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("workflowSlugs")).toBe("wf1,wf2");
    });

    it("parses comma-separated runIds and forwards to provider", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/stats?type=transactional&runIds=run_a,run_b,run_c");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("runIds")).toBe("run_a,run_b,run_c");
    });
  });

  describe("groupBy", () => {
    it("returns grouped broadcast stats from a single provider", async () => {
      mockFetch.mockResolvedValueOnce(
        mockGroupedInstantly([
          { key: "brand_1", recipients: 30 },
          { key: "brand_2", recipients: 20 },
        ])
      );

      const res = await authedGet("/stats?type=broadcast&groupBy=brandId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      expect(res.body.groups[0].key).toBe("brand_1");
      expect(res.body.groups[0].broadcast.emailsSent).toBe(40);
      expect(res.body.groups[0].broadcast.recipients).toBe(30);
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

      const res = await authedGet("/stats?type=transactional&groupBy=campaignId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      expect(res.body.groups[0].key).toBe("camp_1");
      expect(res.body.groups[0].transactional.emailsSent).toBe(50);
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
              { key: "brand_1", recipients: 30 },
              { key: "brand_3", recipients: 25 },
            ])
          );
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/stats?groupBy=brandId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(3);

      const byKey = new Map(res.body.groups.map((g: { key: string }) => [g.key, g]));

      const brand1 = byKey.get("brand_1");
      expect(brand1.transactional.emailsSent).toBe(50);
      expect(brand1.broadcast.emailsSent).toBe(40);

      const brand2 = byKey.get("brand_2");
      expect(brand2.transactional.emailsSent).toBe(50);
      expect(brand2.broadcast).toBeUndefined();

      const brand3 = byKey.get("brand_3");
      expect(brand3.transactional).toBeUndefined();
      expect(brand3.broadcast.emailsSent).toBe(40);
    });

    it("passes groupBy to providers in query params", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010"))
          return Promise.resolve(mockGroupedPostmark([{ key: "wf_1" }]));
        if (url.includes("3011"))
          return Promise.resolve(mockGroupedInstantly([{ key: "wf_1" }]));
        return Promise.reject(new Error("Unexpected URL"));
      });

      await authedGet("/stats?groupBy=workflowSlug");

      for (const call of mockFetch.mock.calls) {
        const params = new URL(call[0]).searchParams;
        expect(params.get("groupBy")).toBe("workflowSlug");
      }
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
            mockGroupedInstantly([{ key: "brand_1", recipients: 30 }])
          );
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/stats?groupBy=brandId");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].key).toBe("brand_1");
      expect(res.body.groups[0].broadcast.emailsSent).toBe(40);
      expect(res.body.groups[0].transactional).toBeUndefined();
    });

    it("normalizes grouped stats (defaults missing reply subtypes to 0)", async () => {
      mockFetch.mockResolvedValueOnce(
        mockGroupedInstantly([{ key: "lead@example.com", recipients: 1 }])
      );

      const res = await authedGet("/stats?type=broadcast&groupBy=leadEmail");

      expect(res.status).toBe(200);
      const group = res.body.groups[0];
      expect(group.broadcast.repliesWillingToMeet).toBe(0);
      expect(group.broadcast.repliesInterested).toBe(0);
      expect(group.broadcast.repliesNotInterested).toBe(1);
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

      const res = await authedGet("/stats?groupBy=brandId");

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

      const res = await authedGet("/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast.emailsSent).toBe(80);
      expect(callCount).toBe(2);
    });

    it("includes URL in error after retries exhausted", async () => {
      mockFetch.mockRejectedValue(new Error("fetch failed"));

      const res = await authedGet("/stats?type=broadcast");

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

      const res = await authedGet("/stats?type=broadcast");

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

      const res = await authedGet("/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailsSent).toBe(100);
      expect(res.body.broadcast.emailsSent).toBe(80);
    });
  });

  describe("stepStats (broadcast only)", () => {
    it("forwards stepStats from instantly in broadcast block", async () => {
      const steps = [
        { step: 1, emailsSent: 10, emailsOpened: 8, emailsReplied: 1, emailsBounced: 1 },
        { step: 2, emailsSent: 10, emailsOpened: 5, emailsReplied: 1, emailsBounced: 1 },
        { step: 3, emailsSent: 10, emailsOpened: 2, emailsReplied: 1, emailsBounced: 0 },
      ];
      mockFetch.mockResolvedValueOnce(mockInstantlyStats({}, steps));

      const res = await authedGet("/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast.stepStats).toEqual(steps);
      expect(res.body.broadcast.emailsSent).toBe(80);
    });

    it("omits stepStats when not present in provider response", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await authedGet("/stats?type=broadcast");

      expect(res.status).toBe(200);
      expect(res.body.broadcast.stepStats).toBeUndefined();
      expect(res.body.broadcast.emailsSent).toBe(80);
    });

    it("includes stepStats in broadcast block when aggregating both providers", async () => {
      const steps = [
        { step: 1, emailsSent: 10, emailsOpened: 8, emailsReplied: 1, emailsBounced: 1 },
      ];
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats({}, steps));
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await authedGet("/stats");

      expect(res.status).toBe(200);
      expect(res.body.transactional.stepStats).toBeUndefined();
      expect(res.body.broadcast.stepStats).toEqual(steps);
    });
  });

  describe("dynasty slug filters", () => {
    it("resolves workflowDynastySlug to workflowSlugs and forwards to providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasty/slugs"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ slugs: ["cold-email", "cold-email-v2"] }),
          });
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/stats?workflowDynastySlug=cold-email");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailsSent).toBe(100);
      expect(res.body.broadcast.emailsSent).toBe(80);

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
            json: () => Promise.resolve({ slugs: ["feat-a", "feat-a-v2"] }),
          });
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/stats?featureDynastySlug=feat-a");

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
            json: () => Promise.resolve({ slugs: [] }),
          });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/stats?workflowDynastySlug=nonexistent");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailsSent).toBe(0);
      expect(res.body.broadcast.emailsSent).toBe(0);
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

      const res = await authedGet("/stats?type=transactional&featureDynastySlug=empty");

      expect(res.status).toBe(200);
      expect(res.body.transactional.emailsSent).toBe(0);
      expect(res.body.broadcast).toBeUndefined();
    });

    it("returns empty groups when dynasty resolves to empty in grouped mode", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasty/slugs"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ slugs: [] }),
          });
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/stats?groupBy=brandId&workflowDynastySlug=nonexistent");

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });

    it("combines workflowDynastySlug with other filters", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasty/slugs"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ slugs: ["wf-1", "wf-1-v2"] }),
          });
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/stats?type=transactional&workflowDynastySlug=wf-1&brandIds=brand_1");

      expect(res.status).toBe(200);
      const params = new URL(mockFetch.mock.calls.find((c) => c[0].includes("3010"))![0]).searchParams;
      expect(params.get("workflowSlugs")).toBe("wf-1,wf-1-v2");
      expect(params.get("brandIds")).toBe("brand_1");
    });

    it("passes featureSlug filter directly to providers", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await authedGet("/stats?type=transactional&featureSlug=my-feature");

      const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
      expect(params.get("featureSlug")).toBe("my-feature");
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
                  { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
                ],
              }),
          });
        if (url.includes("3010"))
          return Promise.resolve(
            mockGroupedPostmark([
              { key: "cold-email", overrides: { emailsSent: 30 } },
              { key: "cold-email-v2", overrides: { emailsSent: 20 } },
            ])
          );
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/stats?type=transactional&groupBy=workflowDynastySlug");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].key).toBe("cold-email");
      // 30 + 20 = 50
      expect(res.body.groups[0].transactional.emailsSent).toBe(50);
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
              { key: "feat-alpha", overrides: { emailsSent: 25 }, recipients: 20 },
              { key: "feat-alpha-v2", overrides: { emailsSent: 15 }, recipients: 10 },
            ])
          );
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/stats?type=broadcast&groupBy=featureDynastySlug");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].key).toBe("feat-alpha");
      expect(res.body.groups[0].broadcast.emailsSent).toBe(40);
      expect(res.body.groups[0].broadcast.recipients).toBe(30);
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

      await authedGet("/stats?type=transactional&groupBy=workflowDynastySlug");

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
                  { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
                ],
              }),
          });
        if (url.includes("3010"))
          return Promise.resolve(
            mockGroupedPostmark([
              { key: "cold-email", overrides: { emailsSent: 30 } },
              { key: "orphan-slug", overrides: { emailsSent: 10 } },
            ])
          );
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/stats?type=transactional&groupBy=workflowDynastySlug");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      const byKey = new Map(res.body.groups.map((g: { key: string }) => [g.key, g]));
      expect(byKey.get("cold-email").transactional.emailsSent).toBe(30);
      expect(byKey.get("orphan-slug").transactional.emailsSent).toBe(10);
    });

    it("merges dynasty groups from both providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("workflow:3021") && url.includes("/workflows/dynasties"))
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                dynasties: [
                  { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
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
              { key: "cold-email", recipients: 20 },
              { key: "cold-email-v2", recipients: 15 },
            ])
          );
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const res = await authedGet("/stats?groupBy=workflowDynastySlug");

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].key).toBe("cold-email");
      // Both provider groups merged under same dynasty
      expect(res.body.groups[0].transactional).toBeDefined();
      expect(res.body.groups[0].broadcast).toBeDefined();
      // Transactional: 50 + 50 = 100
      expect(res.body.groups[0].transactional.emailsSent).toBe(100);
      // Broadcast: 40 + 40 = 80
      expect(res.body.groups[0].broadcast.emailsSent).toBe(80);
    });
  });
});

describe("GET /stats/public", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/stats/public");
    expect(res.status).toBe(401);
  });

  it("succeeds without identity headers", async () => {
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    const res = await serviceAuthGet("/stats/public?type=broadcast");

    expect(res.status).toBe(200);
    expect(res.body.broadcast.emailsSent).toBe(80);
  });

  it("calls downstream /stats/public when no identity headers provided", async () => {
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    await serviceAuthGet("/stats/public?type=broadcast");

    const [fetchUrl, options] = mockFetch.mock.calls[0];
    expect(fetchUrl).toContain("http://localhost:3011/stats/public");
    const headers = options.headers;
    expect(headers["x-org-id"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-run-id"]).toBeUndefined();
  });

  it("calls downstream /stats/public for postmark when no identity headers", async () => {
    mockFetch.mockResolvedValueOnce(mockPostmarkStats());

    await serviceAuthGet("/stats/public?type=transactional&brandIds=brand_1");

    const [fetchUrl] = mockFetch.mock.calls[0];
    expect(fetchUrl).toContain("http://localhost:3010/stats/public");
    const params = new URL(fetchUrl).searchParams;
    expect(params.has("orgId")).toBe(false);
    expect(params.has("userId")).toBe(false);
    expect(params.get("brandIds")).toBe("brand_1");
  });

  it("returns grouped broadcast stats", async () => {
    mockFetch.mockResolvedValueOnce(
      mockGroupedInstantly([
        { key: "brand_1", recipients: 30 },
        { key: "brand_2", recipients: 20 },
      ])
    );

    const res = await serviceAuthGet("/stats/public?type=broadcast&groupBy=brandId");

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);
    expect(res.body.groups[0].key).toBe("brand_1");
    expect(res.body.groups[0].broadcast.emailsSent).toBe(40);
  });

  it("calls downstream /stats (not /stats/public) and forwards headers when caller provides them", async () => {
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    await request(app)
      .get("/stats/public?type=broadcast")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_pub")
      .set("x-user-id", "user_pub")
      .set("x-run-id", "run_pub");

    const [fetchUrl, options] = mockFetch.mock.calls[0];
    expect(fetchUrl).toContain("http://localhost:3011/stats?");
    expect(fetchUrl).not.toContain("/stats/public");
    expect(options.headers["x-org-id"]).toBe("org_pub");
    expect(options.headers["x-user-id"]).toBe("user_pub");
    expect(options.headers["x-run-id"]).toBe("run_pub");
  });

  it("includes orgId/userId in downstream query when caller provides identity headers", async () => {
    mockFetch.mockResolvedValueOnce(mockPostmarkStats());

    await request(app)
      .get("/stats/public?type=transactional")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_pub")
      .set("x-user-id", "user_pub")
      .set("x-run-id", "run_pub");

    const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(params.get("orgId")).toBe("org_pub");
    expect(params.get("userId")).toBe("user_pub");
  });

  it("returns 400 for invalid type", async () => {
    const res = await serviceAuthGet("/stats/public?type=invalid");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("forwards tracking headers from /stats/public route", async () => {
    mockFetch.mockResolvedValueOnce(mockInstantlyStats());

    await serviceAuthGet("/stats/public?type=broadcast")
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
});
