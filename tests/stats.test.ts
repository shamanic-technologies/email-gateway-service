import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";

vi.mock("../src/config", () => ({
  config: {
    port: 3009,
    apiKey: "test-api-key",
    emailFromAddress: "test@example.com",
    postmark: { url: "http://localhost:3010", apiKey: "pm-key" },
    instantly: { url: "http://localhost:3011", apiKey: "inst-key" },
    brand: { url: "http://localhost:3005", apiKey: "brand-key" },
  },
}));

const API_KEY = "test-api-key";
const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockPostmarkStats(overrides = {}) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        stats: {
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

function mockInstantlyStats(overrides = {}) {
  return {
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
          repliesAutoReply: 2,
          repliesNotInterested: 1,
          repliesOutOfOffice: 2,
          repliesUnsubscribe: 0,
          ...overrides,
        },
        recipients: 75,
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

describe("POST /stats", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).post("/stats").send({});
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid type", async () => {
    const res = await request(app)
      .post("/stats")
      .set("X-API-Key", API_KEY)
      .send({ type: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  describe("type: transactional", () => {
    it("returns normalized transactional stats from Postmark", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ type: "transactional", appId: "mcpfactory" });

      expect(res.status).toBe(200);
      expect(res.body.transactional).toEqual({
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

    it("passes filters to Postmark", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({
          type: "transactional",
          appId: "mcpfactory",
          clerkOrgId: "org_123",
          campaignId: "camp_1",
        });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3010/stats");
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body);
      expect(body.appId).toBe("mcpfactory");
      expect(body.clerkOrgId).toBe("org_123");
      expect(body.campaignId).toBe("camp_1");
      expect(body.type).toBeUndefined();
    });
  });

  describe("type: broadcast", () => {
    it("returns normalized broadcast stats from Instantly", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ type: "broadcast", appId: "mcpfactory" });

      expect(res.status).toBe(200);
      expect(res.body.broadcast).toEqual({
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

    it("passes filters to Instantly", async () => {
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({
          type: "broadcast",
          appId: "mcpfactory",
          clerkOrgId: "org_123",
        });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3011/stats");
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body);
      expect(body.appId).toBe("mcpfactory");
      expect(body.clerkOrgId).toBe("org_123");
      expect(body.type).toBeUndefined();
    });
  });

  describe("aggregate (no type)", () => {
    it("returns both transactional and broadcast stats", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010")) return Promise.resolve(mockPostmarkStats());
        if (url.includes("3011")) return Promise.resolve(mockInstantlyStats());
        return Promise.reject(new Error("Unexpected URL"));
      });

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ appId: "mcpfactory" });

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

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ appId: "mcpfactory" });

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

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ appId: "mcpfactory" });

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

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ appId: "mcpfactory" });

      expect(res.status).toBe(200);
      expect(res.body.transactional.error).toBeDefined();
      expect(res.body.broadcast.error).toBeDefined();
    });
  });

  describe("unified normalizer", () => {
    it("uses recipients field when available (Instantly)", async () => {
      mockFetch.mockResolvedValueOnce(
        mockInstantlyStats()
      );

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ type: "broadcast" });

      expect(res.body.broadcast.recipients).toBe(75);
    });

    it("falls back to emailsSent for recipients when field is missing (Postmark)", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ type: "transactional" });

      // Postmark doesn't return recipients, so it falls back to emailsSent
      expect(res.body.transactional.recipients).toBe(100);
    });

    it("defaults missing reply subtypes to 0", async () => {
      // Instantly doesn't return repliesWillingToMeet or repliesInterested
      mockFetch.mockResolvedValueOnce(mockInstantlyStats());

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ type: "broadcast" });

      expect(res.body.broadcast.repliesWillingToMeet).toBe(0);
      expect(res.body.broadcast.repliesInterested).toBe(0);
      expect(res.body.broadcast.repliesNotInterested).toBe(1);
      expect(res.body.broadcast.repliesOutOfOffice).toBe(2);
    });
  });

  describe("workflowName filter", () => {
    it("passes workflowName to provider", async () => {
      mockFetch.mockResolvedValueOnce(mockPostmarkStats());

      await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ type: "transactional", workflowName: "welcome-flow" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.workflowName).toBe("welcome-flow");
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

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ type: "broadcast", groupBy: "brandId" });

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

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ type: "transactional", groupBy: "campaignId" });

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

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ groupBy: "brandId" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(3);

      const byKey = new Map(res.body.groups.map((g: { key: string }) => [g.key, g]));

      // brand_1: both providers
      const brand1 = byKey.get("brand_1");
      expect(brand1.transactional.emailsSent).toBe(50);
      expect(brand1.broadcast.emailsSent).toBe(40);

      // brand_2: postmark only
      const brand2 = byKey.get("brand_2");
      expect(brand2.transactional.emailsSent).toBe(50);
      expect(brand2.broadcast).toBeUndefined();

      // brand_3: instantly only
      const brand3 = byKey.get("brand_3");
      expect(brand3.transactional).toBeUndefined();
      expect(brand3.broadcast.emailsSent).toBe(40);
    });

    it("passes groupBy to providers in request body", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("3010"))
          return Promise.resolve(mockGroupedPostmark([{ key: "wf_1" }]));
        if (url.includes("3011"))
          return Promise.resolve(mockGroupedInstantly([{ key: "wf_1" }]));
        return Promise.reject(new Error("Unexpected URL"));
      });

      await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ groupBy: "workflowName" });

      for (const call of mockFetch.mock.calls) {
        const body = JSON.parse(call[1].body);
        expect(body.groupBy).toBe("workflowName");
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

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ groupBy: "brandId" });

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

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ type: "broadcast", groupBy: "leadEmail" });

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

      const res = await request(app)
        .post("/stats")
        .set("X-API-Key", API_KEY)
        .send({ groupBy: "brandId" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });
  });
});
