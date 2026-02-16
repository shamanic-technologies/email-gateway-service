import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";
import { buildSignature, appendSignature, buildMcpFactorySignature, buildDefaultFooter } from "../src/lib/signature";

// Mock config - vi.mock is hoisted, so use literal values
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

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockBrandResponse(brandUrl = "https://acme.com") {
  return {
    ok: true,
    json: () => Promise.resolve({ brand: { id: "brand_1", brandUrl, name: "Acme", domain: "acme.com" } }),
  };
}

function mockBrandFailure() {
  return {
    ok: false,
    status: 500,
    text: () => Promise.resolve("Brand service error"),
  };
}

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
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
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
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
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
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
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

    it("passes correct payload to instantly-service (non-mcpfactory)", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
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

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [url, options] = mockFetch.mock.calls[1];
      expect(url).toBe("http://localhost:3011/send");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body);
      expect(body.to).toBe("lead@example.com");
      expect(body.firstName).toBe("Jane");
      expect(body.lastName).toBe("Doe");
      expect(body.company).toBe("Acme Corp");
      expect(body.email.subject).toBe("Hello");
      expect(body.email.body).toContain("<p>Hi</p>");
      // non-mcpfactory broadcast: no signature, no unsubscribe
      expect(body.email.body).not.toContain("Kevin Lourd");
      expect(body.email.body).not.toContain("unsubscribe");
      expect(body.variables).toEqual({ source: "test" });
      expect(body.runId).toBe("run_1");
      expect(body.campaignId).toBe("campaign_1");
    });

    it("appends mcpfactory signature for broadcast when appId is mcpfactory", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody({ appId: "mcpfactory" }));

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.email.body).toContain("Kevin Lourd");
      expect(body.email.body).toContain("growthagency.dev");
      expect(body.email.body).not.toContain("unsubscribe");
    });
  });

  describe("transactional (Postmark)", () => {
    it("returns success with messageId", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
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

    it("appends default unsubscribe for non-mcpfactory transactional", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildTransactionalBody());

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.htmlBody).toContain("{{{pm:unsubscribe}}}");
      expect(body.htmlBody).not.toContain("Kevin Lourd");
      expect(body.htmlBody).not.toContain("growthagency.dev");
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

  describe("signature — mcpfactory app", () => {
    it("appends full GrowthAgency signature + Postmark unsubscribe for transactional", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildTransactionalBody({ appId: "mcpfactory" }));

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.htmlBody).toContain("{{{pm:unsubscribe}}}");
      expect(body.htmlBody).not.toContain("{{unsubscribe_url}}");
      expect(body.htmlBody).toContain("Kevin Lourd");
      expect(body.htmlBody).toContain("growthagency.dev");
    });

    it("does not include unsubscribe link for broadcast", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody({ appId: "mcpfactory" }));

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.email.body).not.toContain("unsubscribe");
      expect(body.email.body).not.toContain("{{{pm:unsubscribe}}}");
      expect(body.email.body).toContain("Kevin Lourd");
      expect(body.email.body).toContain("growthagency.dev");
    });

    it("injects brandUrl from brand service into signature", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse("https://mybrand.com"));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody({ appId: "mcpfactory" }));

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.email.body).toContain("https://mybrand.com");
      expect(body.email.body).not.toContain("BRAND_URL");
    });

    it("falls back to BRAND_URL when brand service fails", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandFailure());
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody({ appId: "mcpfactory" }));

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.email.body).toContain("BRAND_URL");
    });

    it("skips brand service call and uses fallback when brandId is omitted", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody({ appId: "mcpfactory", brandId: undefined }));

      // Only one fetch call (instantly), no brand service call
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3011/send");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.email.body).toContain("BRAND_URL");
    });
  });

  describe("signature — default (non-mcpfactory)", () => {
    it("appends only a discrete unsubscribe for transactional", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildTransactionalBody({ appId: "other_app" }));

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.htmlBody).toContain("{{{pm:unsubscribe}}}");
      expect(body.htmlBody).toContain("Unsubscribe");
      expect(body.htmlBody).not.toContain("Kevin Lourd");
      expect(body.htmlBody).not.toContain("growthagency.dev");
      expect(body.htmlBody).not.toContain("BRAND_URL");
    });

    it("does not append anything for broadcast", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody({ appId: "other_app" }));

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      // Should be just the original html body, no footer
      expect(body.email.body).toBe("<p>Hi</p>");
    });

    it("does not append signature when htmlBody is missing (broadcast)", async () => {
      mockFetch.mockResolvedValueOnce(mockBrandResponse());
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await request(app)
        .post("/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody({ htmlBody: undefined, textBody: "plain text" }));

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.email.body).toBe("plain text");
    });
  });
});

describe("buildSignature", () => {
  describe("mcpfactory", () => {
    it("uses Postmark unsubscribe for transactional", () => {
      const sig = buildSignature("transactional", "mcpfactory");
      expect(sig).toContain("{{{pm:unsubscribe}}}");
      expect(sig).not.toContain("{{unsubscribe_url}}");
    });

    it("omits unsubscribe link for broadcast", () => {
      const sig = buildSignature("broadcast", "mcpfactory");
      expect(sig).not.toContain("unsubscribe");
      expect(sig).not.toContain("{{{pm:unsubscribe}}}");
    });

    it("includes GrowthAgency signature content", () => {
      const sig = buildSignature("broadcast", "mcpfactory");
      expect(sig).toContain("Kevin Lourd");
      expect(sig).toContain("Agency");
      expect(sig).toContain("growthagency.dev");
    });

    it("falls back to BRAND_URL when no brandUrl provided", () => {
      const sig = buildSignature("broadcast", "mcpfactory");
      expect(sig).toContain("BRAND_URL");
    });

    it("injects brandUrl when provided", () => {
      const sig = buildSignature("broadcast", "mcpfactory", "https://mybrand.com");
      expect(sig).toContain("https://mybrand.com");
      expect(sig).not.toContain("BRAND_URL");
    });
  });

  describe("default (non-mcpfactory)", () => {
    it("returns discrete unsubscribe for transactional", () => {
      const sig = buildSignature("transactional", "some_app");
      expect(sig).toContain("{{{pm:unsubscribe}}}");
      expect(sig).toContain("Unsubscribe");
      expect(sig).not.toContain("Kevin Lourd");
      expect(sig).not.toContain("growthagency.dev");
    });

    it("returns empty string for broadcast", () => {
      const sig = buildSignature("broadcast", "some_app");
      expect(sig).toBe("");
    });
  });
});

describe("buildMcpFactorySignature", () => {
  it("includes full signature for transactional with unsubscribe", () => {
    const sig = buildMcpFactorySignature("transactional");
    expect(sig).toContain("Kevin Lourd");
    expect(sig).toContain("{{{pm:unsubscribe}}}");
  });

  it("includes full signature for broadcast without unsubscribe", () => {
    const sig = buildMcpFactorySignature("broadcast");
    expect(sig).toContain("Kevin Lourd");
    expect(sig).not.toContain("unsubscribe");
  });
});

describe("buildDefaultFooter", () => {
  it("returns unsubscribe block for transactional", () => {
    const footer = buildDefaultFooter("transactional");
    expect(footer).toContain("{{{pm:unsubscribe}}}");
    expect(footer).toContain("Unsubscribe");
    expect(footer).not.toContain("Kevin Lourd");
  });

  it("returns empty string for broadcast", () => {
    expect(buildDefaultFooter("broadcast")).toBe("");
  });
});

describe("appendSignature", () => {
  it("returns undefined when htmlBody is undefined", () => {
    expect(appendSignature(undefined, "broadcast", "any_app")).toBeUndefined();
  });

  it("appends mcpfactory signature to htmlBody", () => {
    const result = appendSignature("<p>Hello</p>", "transactional", "mcpfactory");
    expect(result).toContain("<p>Hello</p>");
    expect(result).toContain("Kevin Lourd");
    expect(result).toContain("{{{pm:unsubscribe}}}");
  });

  it("appends only unsubscribe for non-mcpfactory transactional", () => {
    const result = appendSignature("<p>Hello</p>", "transactional", "other_app");
    expect(result).toContain("<p>Hello</p>");
    expect(result).toContain("{{{pm:unsubscribe}}}");
    expect(result).not.toContain("Kevin Lourd");
  });

  it("returns original htmlBody for non-mcpfactory broadcast", () => {
    const result = appendSignature("<p>Hello</p>", "broadcast", "other_app");
    expect(result).toBe("<p>Hello</p>");
  });
});
