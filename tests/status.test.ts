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
  },
}));

const API_KEY = "test-api-key";
const mockFetch = vi.fn();
global.fetch = mockFetch;

function authedPost(path: string) {
  return request(app)
    .post(path)
    .set("X-API-Key", API_KEY)
    .set("x-org-id", "org_1")
    .set("x-brand-id", "brand_1");
}

function buildStatusBody(overrides = {}) {
  return {
    campaignId: "camp_1",
    items: [
      { leadId: "lead_1", email: "john@acme.com" },
      { leadId: "lead_2", email: "jane@acme.com" },
    ],
    ...overrides,
  };
}

const emptyScope = {
  lead: { contacted: false, delivered: false, opened: false, replied: false, replyClassification: null, lastDeliveredAt: null },
  email: { contacted: false, delivered: false, opened: false, bounced: false, unsubscribed: false, lastDeliveredAt: null },
};

const deliveredScope = {
  lead: { contacted: true, delivered: true, opened: false, replied: false, replyClassification: null, lastDeliveredAt: "2026-02-20T14:30:00Z" },
  email: { contacted: true, delivered: true, opened: false, bounced: false, unsubscribed: false, lastDeliveredAt: "2026-02-20T14:30:00Z" },
};

const emptyGlobal = { email: { bounced: false, unsubscribed: false } };

function mockProviderResponse(results: unknown[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ results }),
  };
}

function mockServiceError() {
  return {
    ok: false,
    status: 500,
    text: () => Promise.resolve("Internal Server Error"),
  };
}

describe("POST /orgs/status", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/orgs/status")
      .send(buildStatusBody());

    expect(res.status).toBe(401);
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const res = await request(app)
      .post("/orgs/status")
      .set("X-API-Key", API_KEY)
      .send(buildStatusBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("works without x-user-id header (optional)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    const res = await request(app)
      .post("/orgs/status")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_1")
      .set("x-brand-id", "brand_1")
      .send(buildStatusBody());

    expect(res.status).toBe(200);
  });

  it("works without x-run-id header (optional)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    const res = await request(app)
      .post("/orgs/status")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_1")
      .set("x-user-id", "user_1")
      .set("x-brand-id", "brand_1")
      .send(buildStatusBody());

    expect(res.status).toBe(200);
  });

  it("works without x-brand-id header (optional, brand scope is null)", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "l1", email: "john@acme.com", campaign: null, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await request(app)
      .post("/orgs/status")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_1")
      .send({ items: [{ leadId: "l1", email: "john@acme.com" }] });

    expect(res.status).toBe(200);
  });

  it("does not send brandIds to sub-services when x-brand-id is absent", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await request(app)
      .post("/orgs/status")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_1")
      .send({ items: [{ leadId: "l1", email: "john@acme.com" }] });

    for (const call of mockFetch.mock.calls) {
      const body = JSON.parse(call[1].body);
      expect(body.brandIds).toBeUndefined();
    }
  });

  it("returns 400 for empty items array", async () => {
    const res = await authedPost("/orgs/status")
      .send({ items: [] });

    expect(res.status).toBe(400);
  });

  it("returns 400 for missing leadId in items", async () => {
    const res = await authedPost("/orgs/status")
      .send({ items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid email in items", async () => {
    const res = await authedPost("/orgs/status")
      .send({ items: [{ leadId: "l1", email: "not-an-email" }] });

    expect(res.status).toBe(400);
  });

  it("calls both sub-services in parallel and merges results", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: deliveredScope, brand: deliveredScope, global: emptyGlobal },
          { leadId: "lead_2", email: "jane@acme.com", campaign: emptyScope, brand: emptyScope, global: emptyGlobal },
        ]));
      }
      if (url.includes("3010")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: emptyScope, brand: emptyScope, global: emptyGlobal },
        ]));
      }
      return Promise.reject(new Error("unexpected url"));
    });

    const res = await authedPost("/orgs/status").send(buildStatusBody());

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);

    const first = res.body.results[0];
    expect(first.leadId).toBe("lead_1");
    expect(first.email).toBe("john@acme.com");
    expect(first.broadcast).toBeDefined();
    expect(first.broadcast.campaign.lead.delivered).toBe(true);
    expect(first.broadcast.brand.lead.delivered).toBe(true);
    expect(first.broadcast.global.email.bounced).toBe(false);
    expect(first.transactional).toBeDefined();

    const second = res.body.results[1];
    expect(second.leadId).toBe("lead_2");
    expect(second.broadcast).toBeDefined();
    expect(second.transactional).toBeUndefined();
  });

  it("forwards identity headers to both sub-services when present", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status")
      .set("x-user-id", "user_1")
      .set("x-run-id", "run_1")
      .send(buildStatusBody());

    expect(mockFetch).toHaveBeenCalledTimes(2);

    for (const call of mockFetch.mock.calls) {
      const headers = call[1].headers;
      expect(headers["x-org-id"]).toBe("org_1");
      expect(headers["x-user-id"]).toBe("user_1");
      expect(headers["x-run-id"]).toBe("run_1");
    }
  });

  it("forwards campaignId and items (not brandIds) in body to both sub-services", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status").send(buildStatusBody());

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const calls = mockFetch.mock.calls.map(([url, opts]: [string, { body: string }]) => ({
      url,
      body: JSON.parse(opts.body),
    }));

    for (const call of calls) {
      expect(call.body.brandIds).toBeUndefined();
      expect(call.body.campaignId).toBe("camp_1");
      expect(call.body.items).toHaveLength(2);
      expect(call.body.items[0]).toEqual({ leadId: "lead_1", email: "john@acme.com" });
    }

    const urls = calls.map((c) => c.url);
    expect(urls).toContain("http://localhost:3011/status");
    expect(urls).toContain("http://localhost:3010/orgs/status");
  });

  it("works without campaignId (optional)", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: null, brand: deliveredScope, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send(buildStatusBody({ campaignId: undefined, items: [{ leadId: "lead_1", email: "john@acme.com" }] }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign).toBeNull();
    expect(res.body.results[0].broadcast.brand.lead.delivered).toBe(true);
  });

  it("returns results when only broadcast succeeds", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: deliveredScope, brand: deliveredScope, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockServiceError());
    });

    const res = await authedPost("/orgs/status")
      .send(buildStatusBody({ items: [{ leadId: "lead_1", email: "john@acme.com" }] }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast).toBeDefined();
    expect(res.body.results[0].transactional).toBeUndefined();
  });

  it("returns results when only transactional succeeds", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3010")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: deliveredScope, brand: deliveredScope, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockServiceError());
    });

    const res = await authedPost("/orgs/status")
      .send(buildStatusBody({ items: [{ leadId: "lead_1", email: "john@acme.com" }] }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].transactional).toBeDefined();
    expect(res.body.results[0].broadcast).toBeUndefined();
  });

  it("returns 502 when both sub-services fail", async () => {
    mockFetch.mockResolvedValue(mockServiceError());

    const res = await authedPost("/orgs/status")
      .send(buildStatusBody({ items: [{ leadId: "lead_1", email: "john@acme.com" }] }));

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Both upstream services failed");
  });

  it("forwards tracking headers to both sub-services", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status")
      .set("x-campaign-id", "camp_hdr")
      .set("x-brand-id", "brand_hdr")
      .set("x-workflow-slug", "wf_hdr")
      .set("x-feature-slug", "feat_hdr")
      .send(buildStatusBody());

    expect(mockFetch).toHaveBeenCalledTimes(2);

    for (const call of mockFetch.mock.calls) {
      const headers = call[1].headers;
      expect(headers["x-campaign-id"]).toBe("camp_hdr");
      expect(headers["x-brand-id"]).toBe("brand_hdr");
      expect(headers["x-workflow-slug"]).toBe("wf_hdr");
      expect(headers["x-feature-slug"]).toBe("feat_hdr");
    }
  });

  it("works without optional tracking headers (x-campaign-id, x-workflow-slug, x-feature-slug)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status").send(buildStatusBody());

    for (const call of mockFetch.mock.calls) {
      const headers = call[1].headers;
      expect(headers["x-campaign-id"]).toBeUndefined();
      // x-brand-id IS present (set by authedPost)
      expect(headers["x-brand-id"]).toBe("brand_1");
      expect(headers["x-workflow-slug"]).toBeUndefined();
      expect(headers["x-feature-slug"]).toBeUndefined();
    }
  });

  it("includes brand scope in merged results", async () => {
    const brandDelivered = {
      lead: { contacted: true, delivered: true, opened: true, replied: true, replyClassification: "positive" as const, lastDeliveredAt: "2026-02-22T10:00:00Z" },
      email: { contacted: true, delivered: true, opened: true, bounced: false, unsubscribed: true, lastDeliveredAt: "2026-02-22T10:00:00Z" },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: deliveredScope, brand: brandDelivered, global: { email: { bounced: false, unsubscribed: true } } },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send(buildStatusBody({ items: [{ leadId: "lead_1", email: "john@acme.com" }] }));

    expect(res.status).toBe(200);
    const broadcast = res.body.results[0].broadcast;
    expect(broadcast.brand.lead.replied).toBe(true);
    expect(broadcast.brand.email.unsubscribed).toBe(true);
    expect(broadcast.global.email.unsubscribed).toBe(true);
  });

  it("forwards x-brand-id header (not body) to both sub-services", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status")
      .set("x-brand-id", "brand_a,brand_b,brand_c")
      .send(buildStatusBody());

    expect(mockFetch).toHaveBeenCalledTimes(2);

    for (const call of mockFetch.mock.calls) {
      const headers = call[1].headers;
      expect(headers["x-brand-id"]).toBe("brand_a,brand_b,brand_c");
      const body = JSON.parse(call[1].body);
      expect(body.brandIds).toBeUndefined();
    }
  });

  it("passes through replyClassification from broadcast provider", async () => {
    const repliedScope = {
      lead: { contacted: true, delivered: true, opened: true, replied: true, replyClassification: "positive", lastDeliveredAt: "2026-03-01T10:00:00Z" },
      email: { contacted: true, delivered: true, opened: true, bounced: false, unsubscribed: false, lastDeliveredAt: "2026-03-01T10:00:00Z" },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: repliedScope, brand: repliedScope, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send(buildStatusBody({ items: [{ leadId: "lead_1", email: "john@acme.com" }] }));

    expect(res.status).toBe(200);
    const broadcast = res.body.results[0].broadcast;
    expect(broadcast.campaign.lead.replyClassification).toBe("positive");
    expect(broadcast.brand.lead.replyClassification).toBe("positive");
  });

  it("passes through negative replyClassification", async () => {
    const negativeScope = {
      lead: { contacted: true, delivered: true, opened: false, replied: true, replyClassification: "negative", lastDeliveredAt: "2026-03-01T10:00:00Z" },
      email: { contacted: true, delivered: true, opened: false, bounced: false, unsubscribed: false, lastDeliveredAt: "2026-03-01T10:00:00Z" },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: negativeScope, brand: negativeScope, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send(buildStatusBody({ items: [{ leadId: "lead_1", email: "john@acme.com" }] }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign.lead.replyClassification).toBe("negative");
  });

  it("returns null replyClassification when lead has not replied", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: emptyScope, brand: emptyScope, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send(buildStatusBody({ items: [{ leadId: "lead_1", email: "john@acme.com" }] }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign.lead.replyClassification).toBeNull();
  });

  it("passes through opened field from broadcast provider", async () => {
    const openedScope = {
      lead: { contacted: true, delivered: true, opened: true, replied: false, replyClassification: null, lastDeliveredAt: "2026-03-01T10:00:00Z" },
      email: { contacted: true, delivered: true, opened: true, bounced: false, unsubscribed: false, lastDeliveredAt: "2026-03-01T10:00:00Z" },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { leadId: "lead_1", email: "john@acme.com", campaign: openedScope, brand: openedScope, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send(buildStatusBody({ items: [{ leadId: "lead_1", email: "john@acme.com" }] }));

    expect(res.status).toBe(200);
    const broadcast = res.body.results[0].broadcast;
    expect(broadcast.campaign.lead.opened).toBe(true);
    expect(broadcast.campaign.email.opened).toBe(true);
    expect(broadcast.brand.lead.opened).toBe(true);
    expect(broadcast.brand.email.opened).toBe(true);
  });

  it("accepts large payloads without 413 error", async () => {
    const largeItems = Array.from({ length: 2000 }, (_, i) => ({
      leadId: `lead_${i}`,
      email: `user${i}@example.com`,
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: largeItems });

    expect(res.status).not.toBe(413);
    expect(res.status).toBe(200);
  });
});
