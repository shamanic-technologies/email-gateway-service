import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";

// Mock config - vi.mock is hoisted, so use literal values
vi.mock("../src/config", () => ({
  config: {
    port: 3009,
    apiKey: "test-api-key",
    emailFromAddress: "test@example.com",
    postmark: { url: "http://localhost:3010", apiKey: "pm-key" },
    instantly: { url: "http://localhost:3011", apiKey: "inst-key" },
  },
}));

const API_KEY = "test-api-key";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function buildBroadcastBody(overrides = {}) {
  return {
    type: "broadcast",
    appId: "app_1",
    brandId: "brand_1",
    campaignId: "campaign_1",
    runId: "run_1",
    clerkOrgId: "org_1",
    to: "lead@example.com",
    recipientFirstName: "Jane",
    recipientLastName: "Doe",
    recipientCompany: "Acme Corp",
    subject: "Hello",
    htmlBody: "<p>Hi</p>",
    ...overrides,
  };
}

function buildTransactionalBody(overrides = {}) {
  return {
    type: "transactional",
    appId: "app_1",
    brandId: "brand_1",
    campaignId: "campaign_1",
    runId: "run_1",
    clerkOrgId: "org_1",
    to: "user@example.com",
    recipientFirstName: "John",
    recipientLastName: "Smith",
    recipientCompany: "Corp Inc",
    subject: "Welcome",
    htmlBody: "<p>Welcome</p>",
    ...overrides,
  };
}

describe("POST /send", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("broadcast (Instantly)", () => {
    it("returns success with campaignId and messageId when added > 0", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            campaignId: "inst_camp_123",
            leadId: "lead_456",
            added: 1,
          }),
      });

      const res = await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        provider: "broadcast",
        messageId: "lead_456",
        campaignId: "inst_camp_123",
      });
    });

    it("returns 409 when added === 0 (duplicate lead)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            campaignId: "inst_camp_123",
            leadId: null,
            added: 0,
          }),
      });

      const res = await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody());

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("not added");
      expect(res.body.campaignId).toBe("inst_camp_123");
    });

    it("returns 502 when instantly-service is down", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      const res = await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody());

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Upstream service error");
    });

    it("passes correct payload to instantly-service", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            campaignId: "inst_camp_123",
            leadId: "lead_1",
            added: 1,
          }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(
          buildBroadcastBody({
            metadata: { source: "test" },
          })
        );

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3011/send");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body);
      expect(body.to).toBe("lead@example.com");
      expect(body.firstName).toBe("Jane");
      expect(body.lastName).toBe("Doe");
      expect(body.company).toBe("Acme Corp");
      expect(body.email.subject).toBe("Hello");
      expect(body.email.body).toBe("<p>Hi</p>");
      expect(body.variables).toEqual({ source: "test" });
      expect(body.runId).toBe("run_1");
      expect(body.campaignId).toBe("campaign_1");
    });
  });

  describe("transactional (Postmark)", () => {
    it("returns success with messageId", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            messageId: "pm_msg_789",
          }),
      });

      const res = await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildTransactionalBody());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        provider: "transactional",
        messageId: "pm_msg_789",
      });
    });
  });

  describe("validation", () => {
    it("returns 400 for missing required fields", async () => {
      const res = await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send({ type: "broadcast" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid request");
    });

    it("returns 401 without API key", async () => {
      const res = await request(app)
        .post("/send")
        .send(buildBroadcastBody());

      expect(res.status).toBe(401);
    });
  });
});
