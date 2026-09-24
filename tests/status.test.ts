import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";
import { StatusRequestSchema } from "../src/schemas";

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
    runs: { url: "", apiKey: "" },
  },
}));

const API_KEY = "test-api-key";
const mockFetch = vi.fn();

// Both providers answer `/orgs/status` with ONE row per requested item (an
// address with no data is a row with null scopes), and the gateway now refuses
// an answer missing any requested address. Fixtures below list only the rows a
// test cares about, so pad the rest the way a real provider would. Tests that
// exercise a truncated provider answer switch this off.
let padMissingRows = true;
const emptyProviderRow = (email: string) => ({
  email,
  byCampaign: null,
  campaign: null,
  brand: null,
  global: { email: { bounced: false, unsubscribed: false } },
});
global.fetch = (async (url: string, init?: RequestInit) => {
  const response = await mockFetch(url, init);
  if (!padMissingRows || !response?.ok || typeof init?.body !== "string") return response;
  const { items } = JSON.parse(init.body) as { items?: Array<{ email: string }> };
  if (!items) return response;
  const body = (await response.json()) as { results?: Array<{ email: string }> };
  const results = [...(body.results ?? [])];
  for (const { email } of items) {
    if (!results.some((r) => r.email === email)) results.push(emptyProviderRow(email));
  }
  return { ...response, ok: true, json: () => Promise.resolve({ ...body, results }) };
}) as typeof fetch;

function authedPost(path: string) {
  return request(app)
    .post(path)
    .set("X-API-Key", API_KEY)
    .set("x-org-id", "org_1")
    .set("x-brand-id", "brand_1");
}

const emptyScope = {
  contacted: false,
  sent: false,
  delivered: false,
  opened: false,
  clicked: false,
  replied: false,
  replyClassification: null,
  bounced: false,
  unsubscribed: false,
  lastDeliveredAt: null,
};

const deliveredScope = {
  contacted: true,
  sent: true,
  delivered: true,
  opened: false,
  clicked: false,
  replied: false,
  replyClassification: null,
  bounced: false,
  unsubscribed: false,
  lastDeliveredAt: "2026-02-20T14:30:00Z",
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
    padMissingRows = true;
  });

  // --- Auth & validation ---

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(401);
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const res = await request(app)
      .post("/orgs/status")
      .set("X-API-Key", API_KEY)
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("org mode: returns 200 when neither brandId nor campaignId is provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    const res = await authedPost("/orgs/status")
      .send({ items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
  });

  it("returns 400 for empty items array", async () => {
    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [] });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid email in items", async () => {
    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "not-an-email" }] });

    expect(res.status).toBe(400);
  });

  // --- Campaign mode ---

  it("campaign mode: sends campaignId in body to both providers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    for (const call of mockFetch.mock.calls) {
      const body = JSON.parse(call[1].body);
      expect(body.campaignId).toBe("camp_1");
      expect(body.items).toEqual([{ email: "john@acme.com" }]);
    }
  });

  it("campaign mode: returns campaign + global, byCampaign and brand are null", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: deliveredScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    const broadcast = res.body.results[0].broadcast;
    expect(broadcast.campaign.delivered).toBe(true);
    expect(broadcast.byCampaign).toBeNull();
    expect(broadcast.brand).toBeNull();
    expect(broadcast.global.email.bounced).toBe(false);
  });

  it("campaign mode: brandId is ignored when campaignId is present", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    const res = await authedPost("/orgs/status")
      .send({ brandId: "brand_1", campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);

    for (const call of mockFetch.mock.calls) {
      const body = JSON.parse(call[1].body);
      expect(body.campaignId).toBe("camp_1");
      expect(body.brandId).toBe("brand_1");
    }
  });

  // --- Brand mode ---

  it("brand mode: sends brandId in body to both providers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status")
      .send({ brandId: "brand_1", items: [{ email: "john@acme.com" }] });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    for (const call of mockFetch.mock.calls) {
      const body = JSON.parse(call[1].body);
      expect(body.brandId).toBe("brand_1");
      expect(body.campaignId).toBeUndefined();
    }
  });

  it("brand mode: returns byCampaign + brand + global, campaign is null", async () => {
    const byCampaign = {
      "camp-uuid-1": { ...deliveredScope },
      "camp-uuid-2": { ...emptyScope },
    };
    const brandAgg = { ...deliveredScope };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign, campaign: null, brand: brandAgg, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ brandId: "brand_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    const broadcast = res.body.results[0].broadcast;
    expect(broadcast.byCampaign["camp-uuid-1"].delivered).toBe(true);
    expect(broadcast.byCampaign["camp-uuid-2"].delivered).toBe(false);
    expect(broadcast.brand.delivered).toBe(true);
    expect(broadcast.campaign).toBeNull();
    expect(broadcast.global.email.bounced).toBe(false);
  });

  // --- Merging providers ---

  it("merges broadcast and transactional results per email", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: deliveredScope, brand: null, global: emptyGlobal },
          { email: "jane@acme.com", byCampaign: null, campaign: emptyScope, brand: null, global: emptyGlobal },
        ]));
      }
      if (url.includes("3010")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: emptyScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.reject(new Error("unexpected url"));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }, { email: "jane@acme.com" }] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);

    const first = res.body.results[0];
    expect(first.email).toBe("john@acme.com");
    expect(first.broadcast).toBeDefined();
    expect(first.broadcast.campaign.delivered).toBe(true);
    expect(first.transactional).toBeDefined();

    const second = res.body.results[1];
    expect(second.broadcast).toBeDefined();
    // postmark answered jane with an empty row: present, no scopes.
    expect(second.transactional.campaign).toBeNull();
  });

  it("no leadId in response", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: deliveredScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).not.toHaveProperty("leadId");
  });

  // --- A provider that fails or answers partially fails the whole read ---
  // A consumer reads an absent `broadcast` block as "never contacted", so a 200
  // with one provider missing is a partial answer that looks complete. On
  // 2026-09-24 instantly-service redeployed, its `fetch failed` was swallowed,
  // and a customer's `contacted` count dropped by exactly 1,000 (ten 100-address
  // batches) for one refresh.

  it("returns 502, not a broadcast-less 200, when instantly-service fails", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3010")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: deliveredScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockServiceError());
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(502);
    expect(res.body.details).toContain("instantly-service");
    expect(res.body.results).toBeUndefined();
  });

  it("returns 502, not a transactional-less 200, when postmark-service fails", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: deliveredScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockServiceError());
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(502);
    expect(res.body.details).toContain("postmark-service");
    expect(res.body.results).toBeUndefined();
  });

  it("returns 502 when both sub-services fail", async () => {
    mockFetch.mockResolvedValue(mockServiceError());

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(502);
    expect(res.body.results).toBeUndefined();
  });

  it("a bulk read during an instantly-service restart yields errors or complete answers, never a partial 200", async () => {
    // lead-service reads in 100-address batches. instantly-service is down
    // (connection refused → `fetch failed`) for the first 10 batches' calls,
    // then back. postmark stays up throughout.
    let instantlyDown = true;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("3011") && instantlyDown) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      const { items } = JSON.parse(init!.body as string) as { items: Array<{ email: string }> };
      const scope = url.includes("3011") ? deliveredScope : emptyScope;
      return Promise.resolve(mockProviderResponse(
        items.map((i) => ({ email: i.email, byCampaign: null, campaign: scope, brand: null, global: emptyGlobal })),
      ));
    });

    const batch = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({ email: `b${n}-u${i}@acme.com` }));

    const during = [];
    for (let n = 0; n < 10; n++) {
      during.push(await authedPost("/orgs/status").send({ campaignId: "camp_1", items: batch(n) }));
    }
    instantlyDown = false;
    const after = await authedPost("/orgs/status").send({ campaignId: "camp_1", items: batch(10) });

    for (const res of during) {
      expect(res.status).toBe(502);
      expect(res.body.results).toBeUndefined();
    }
    expect(after.status).toBe(200);
    expect(after.body.results).toHaveLength(100);
    expect(after.body.results.every((r: { broadcast?: { campaign: { contacted: boolean } } }) =>
      r.broadcast?.campaign.contacted === true)).toBe(true);
  });

  it("rides out a restart shorter than the retry window with a complete answer", async () => {
    let instantlyCalls = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011") && instantlyCalls++ === 0) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(mockProviderResponse([
        { email: "john@acme.com", byCampaign: null, campaign: deliveredScope, brand: null, global: emptyGlobal },
      ]));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign.contacted).toBe(true);
  });

  it("returns 502 when a provider answers for only some of the requested addresses", async () => {
    padMissingRows = false;
    const items = Array.from({ length: 100 }, (_, i) => ({ email: `u${i}@acme.com` }));
    mockFetch.mockImplementation((url: string) => {
      const answered = url.includes("3011") ? items.slice(0, 99) : items;
      return Promise.resolve(mockProviderResponse(
        answered.map((i) => ({ email: i.email, byCampaign: null, campaign: emptyScope, brand: null, global: emptyGlobal })),
      ));
    });

    const res = await authedPost("/orgs/status").send({ campaignId: "camp_1", items });

    expect(res.status).toBe(502);
    expect(res.body.details).toContain("instantly-service");
    expect(res.body.details).toContain("1 of 100");
  });

  // --- Header forwarding (tracing only) ---

  it("forwards all identity headers to both sub-services", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status")
      .set("x-user-id", "user_1")
      .set("x-run-id", "run_1")
      .set("x-campaign-id", "camp_hdr")
      .set("x-workflow-slug", "wf_hdr")
      .set("x-feature-slug", "feat_hdr")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    for (const call of mockFetch.mock.calls) {
      const headers = call[1].headers;
      expect(headers["x-org-id"]).toBe("org_1");
      expect(headers["x-user-id"]).toBe("user_1");
      expect(headers["x-run-id"]).toBe("run_1");
      expect(headers["x-campaign-id"]).toBe("camp_hdr");
      expect(headers["x-brand-id"]).toBe("brand_1");
      expect(headers["x-workflow-slug"]).toBe("wf_hdr");
      expect(headers["x-feature-slug"]).toBe("feat_hdr");
    }
  });

  it("headers are for tracing only — brandId filter is in body, not derived from x-brand-id header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status")
      .set("x-brand-id", "header_brand")
      .send({ brandId: "body_brand", items: [{ email: "john@acme.com" }] });

    for (const call of mockFetch.mock.calls) {
      const headers = call[1].headers;
      expect(headers["x-brand-id"]).toBe("header_brand");
      const body = JSON.parse(call[1].body);
      expect(body.brandId).toBe("body_brand");
    }
  });

  it("works without optional tracking headers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await request(app)
      .post("/orgs/status")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", "org_1")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    for (const call of mockFetch.mock.calls) {
      const headers = call[1].headers;
      expect(headers["x-org-id"]).toBe("org_1");
      expect(headers["x-campaign-id"]).toBeUndefined();
      expect(headers["x-brand-id"]).toBeUndefined();
    }
  });

  // --- replyClassification passthrough ---

  it("passes through replyClassification from providers", async () => {
    const repliedScope = {
      contacted: true,
      sent: true,
      delivered: true,
      opened: true,
      clicked: false,
      replied: true,
      replyClassification: "positive",
      bounced: false,
      unsubscribed: false,
      lastDeliveredAt: "2026-03-01T10:00:00Z",
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: repliedScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign.replyClassification).toBe("positive");
  });

  it("passes through sentCount per scope from both providers (broadcast + transactional)", async () => {
    // Broadcast (instantly) reports 3 sends to this recipient in the campaign;
    // transactional (postmark) reports 1. email-gateway forwards each provider's
    // per-scope send-event count untouched — the consumer derives sequence
    // position from it (1 = initial, 2 = first follow-up, ...).
    const broadcastScope = { ...deliveredScope, sentCount: 3 };
    const transactionalScope = { ...deliveredScope, sentCount: 1 };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: broadcastScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([
        { email: "john@acme.com", byCampaign: null, campaign: transactionalScope, brand: null, global: emptyGlobal },
      ]));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign.sentCount).toBe(3);
    expect(res.body.results[0].transactional.campaign.sentCount).toBe(1);
  });

  it("passes through per-campaign sentCount and brand-summed sentCount (brand mode)", async () => {
    // Brand mode: byCampaign carries each campaign's own count; brand scope is
    // the SUM across the brand's campaigns (2 + 1 = 3 emails to this recipient).
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          {
            email: "john@acme.com",
            byCampaign: {
              "camp-uuid-1": { ...deliveredScope, sentCount: 2 },
              "camp-uuid-2": { ...deliveredScope, sentCount: 1 },
            },
            campaign: null,
            brand: { ...deliveredScope, sentCount: 3 },
            global: emptyGlobal,
          },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ brandId: "brand_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    const broadcast = res.body.results[0].broadcast;
    expect(broadcast.byCampaign["camp-uuid-1"].sentCount).toBe(2);
    expect(broadcast.byCampaign["camp-uuid-2"].sentCount).toBe(1);
    expect(broadcast.brand.sentCount).toBe(3);
  });

  it("omits sentCount transparently when a provider predates it (absent-safe)", async () => {
    // A provider still on the old contract returns no sentCount → the field is
    // simply absent; the passthrough must not fabricate or default it.
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: deliveredScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign).not.toHaveProperty("sentCount");
  });

  it("returns null replyClassification when no reply", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: emptyScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign.replyClassification).toBeNull();
  });

  // --- first*At engagement-event timestamp passthrough ---

  it("passes through first*At engagement timestamps, distinguishable by event type", async () => {
    const T1_OPEN = "2026-03-01T10:00:00.000Z";
    const T2_CLICK = "2026-03-03T14:30:00.000Z"; // strictly after open
    const engagedScope = {
      ...deliveredScope,
      opened: true,
      clicked: true,
      firstContactedAt: "2026-02-28T09:00:00.000Z",
      firstSentAt: "2026-02-28T09:00:01.000Z",
      firstDeliveredAt: "2026-02-28T09:05:00.000Z",
      firstOpenedAt: T1_OPEN,
      firstClickedAt: T2_CLICK,
      firstRepliedAt: null,
      firstBouncedAt: null,
      firstUnsubscribedAt: null,
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: engagedScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    const scope = res.body.results[0].broadcast.campaign;
    expect(scope.firstOpenedAt).toBe(T1_OPEN);
    expect(scope.firstClickedAt).toBe(T2_CLICK);
    // open precedes click — the consumer can order the funnel chronologically
    expect(new Date(scope.firstOpenedAt).getTime()).toBeLessThan(new Date(scope.firstClickedAt).getTime());
    expect(scope.firstRepliedAt).toBeNull();
  });

  it("passes through null first*At for an un-engaged recipient", async () => {
    const noEngagementScope = {
      ...deliveredScope,
      firstContactedAt: "2026-02-28T09:00:00.000Z",
      firstSentAt: "2026-02-28T09:00:01.000Z",
      firstDeliveredAt: "2026-02-28T09:05:00.000Z",
      firstOpenedAt: null,
      firstClickedAt: null,
      firstRepliedAt: null,
      firstBouncedAt: null,
      firstUnsubscribedAt: null,
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: noEngagementScope, brand: null, global: emptyGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    const scope = res.body.results[0].broadcast.campaign;
    expect(scope.firstOpenedAt).toBeNull();
    expect(scope.firstClickedAt).toBeNull();
    expect(scope.firstDeliveredAt).toBe("2026-02-28T09:05:00.000Z");
  });

  it("passes through first*At on brand + byCampaign scopes (brand mode)", async () => {
    const campOne = {
      ...deliveredScope,
      opened: true,
      firstOpenedAt: "2026-03-01T10:00:00.000Z",
      firstClickedAt: null,
    };
    const campTwo = {
      ...deliveredScope,
      opened: true,
      clicked: true,
      firstOpenedAt: "2026-02-20T08:00:00.000Z",
      firstClickedAt: "2026-02-21T08:00:00.000Z",
    };
    const brandAgg = {
      ...deliveredScope,
      opened: true,
      clicked: true,
      firstOpenedAt: "2026-02-20T08:00:00.000Z", // MIN across campaigns
      firstClickedAt: "2026-02-21T08:00:00.000Z",
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          {
            email: "john@acme.com",
            byCampaign: { "camp-uuid-1": campOne, "camp-uuid-2": campTwo },
            campaign: null,
            brand: brandAgg,
            global: emptyGlobal,
          },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ brandId: "brand_1", items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    const broadcast = res.body.results[0].broadcast;
    expect(broadcast.byCampaign["camp-uuid-1"].firstOpenedAt).toBe("2026-03-01T10:00:00.000Z");
    expect(broadcast.byCampaign["camp-uuid-1"].firstClickedAt).toBeNull();
    expect(broadcast.byCampaign["camp-uuid-2"].firstClickedAt).toBe("2026-02-21T08:00:00.000Z");
    expect(broadcast.brand.firstOpenedAt).toBe("2026-02-20T08:00:00.000Z");
    expect(broadcast.brand.firstClickedAt).toBe("2026-02-21T08:00:00.000Z");
  });

  // --- Large payloads ---

  it("accepts large payloads without 413 error", async () => {
    const largeItems = Array.from({ length: 2000 }, (_, i) => ({
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

  // --- Org mode (no brandId, no campaignId) ---

  it("org mode: forwards body without brandId/campaignId to both providers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await authedPost("/orgs/status")
      .send({ items: [{ email: "john@acme.com" }] });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    for (const call of mockFetch.mock.calls) {
      const body = JSON.parse(call[1].body);
      expect(body.brandId).toBeUndefined();
      expect(body.campaignId).toBeUndefined();
      expect(body.items).toEqual([{ email: "john@acme.com" }]);
    }
  });

  it("org mode: broadcast.global populated; brand/campaign/byCampaign null", async () => {
    const orgGlobal = { email: { bounced: true, unsubscribed: false } };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3011")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: null, brand: null, global: orgGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    const broadcast = res.body.results[0].broadcast;
    expect(broadcast.global).toEqual(orgGlobal);
    expect(broadcast.brand).toBeNull();
    expect(broadcast.campaign).toBeNull();
    expect(broadcast.byCampaign).toBeNull();
  });

  it("org mode: transactional.global populated; brand/campaign/byCampaign null", async () => {
    const orgGlobal = { email: { bounced: false, unsubscribed: true } };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("3010")) {
        return Promise.resolve(mockProviderResponse([
          { email: "john@acme.com", byCampaign: null, campaign: null, brand: null, global: orgGlobal },
        ]));
      }
      return Promise.resolve(mockProviderResponse([]));
    });

    const res = await authedPost("/orgs/status")
      .send({ items: [{ email: "john@acme.com" }] });

    expect(res.status).toBe(200);
    const transactional = res.body.results[0].transactional;
    expect(transactional.global).toEqual(orgGlobal);
    expect(transactional.brand).toBeNull();
    expect(transactional.campaign).toBeNull();
    expect(transactional.byCampaign).toBeNull();
  });

  // --- No data for email ---

  it("returns email with no provider data when not found", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    const res = await authedPost("/orgs/status")
      .send({ campaignId: "camp_1", items: [{ email: "nobody@acme.com" }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].email).toBe("nobody@acme.com");
    // Each provider answers an unknown address with a row carrying no scopes.
    expect(res.body.results[0].broadcast.campaign).toBeNull();
    expect(res.body.results[0].transactional.campaign).toBeNull();
    expect(res.body.results[0]).not.toHaveProperty("leadId");
  });
});

describe("StatusRequestSchema", () => {
  it("accepts request with neither brandId nor campaignId", () => {
    const result = StatusRequestSchema.safeParse({
      items: [{ email: "john@acme.com" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts request with only brandId", () => {
    const result = StatusRequestSchema.safeParse({
      brandId: "brand_1",
      items: [{ email: "john@acme.com" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts request with only campaignId", () => {
    const result = StatusRequestSchema.safeParse({
      campaignId: "camp_1",
      items: [{ email: "john@acme.com" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts request with both brandId and campaignId", () => {
    const result = StatusRequestSchema.safeParse({
      brandId: "brand_1",
      campaignId: "camp_1",
      items: [{ email: "john@acme.com" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty items array", () => {
    const result = StatusRequestSchema.safeParse({ items: [] });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = StatusRequestSchema.safeParse({
      items: [{ email: "not-an-email" }],
    });
    expect(result.success).toBe(false);
  });
});

// --- Reply kind / disqualified passthrough (instantly-service owns both) ---

describe("POST /orgs/status — replyKind + disqualified passthrough", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    padMissingRows = true;
  });

  function scopeWithKind(replyKind: string | null, disqualified: boolean) {
    return {
      ...deliveredScope,
      replied: replyKind !== null,
      replyClassification: replyKind === null ? null : "negative",
      replyKind,
      disqualified,
    };
  }

  function mockBothProviders(broadcastResults: unknown[], transactionalResults: unknown[]) {
    mockFetch.mockImplementation((url: string) => {
      const results = url.includes("3011") ? broadcastResults : transactionalResults;
      return Promise.resolve(mockProviderResponse(results));
    });
  }

  it("carries replyKind + disqualified on every scope the read answers for", async () => {
    const perCampaign = scopeWithKind("lead_wrong_person", true);
    const brand = scopeWithKind("lead_wrong_person", true);
    mockBothProviders(
      [
        {
          email: "john@acme.com",
          byCampaign: { camp_1: perCampaign },
          campaign: null,
          brand,
          global: emptyGlobal,
        },
      ],
      [],
    );

    const res = await authedPost("/orgs/status").send({
      brandId: "brand_1",
      items: [{ email: "john@acme.com" }],
    });

    expect(res.status).toBe(200);
    const broadcast = res.body.results[0].broadcast;
    expect(broadcast.byCampaign.camp_1.replyKind).toBe("lead_wrong_person");
    expect(broadcast.byCampaign.camp_1.disqualified).toBe(true);
    expect(broadcast.brand.replyKind).toBe("lead_wrong_person");
    expect(broadcast.brand.disqualified).toBe(true);
  });

  it("carries them on the campaign scope too", async () => {
    mockBothProviders(
      [
        {
          email: "john@acme.com",
          byCampaign: null,
          campaign: scopeWithKind("lead_not_interested", false),
          brand: null,
          global: emptyGlobal,
        },
      ],
      [],
    );

    const res = await authedPost("/orgs/status").send({
      campaignId: "camp_1",
      items: [{ email: "john@acme.com" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign).toEqual(
      scopeWithKind("lead_not_interested", false),
    );
  });

  // A recyclable "no" and a permanent one are both `negative` — the coarse
  // value is unchanged and the finer one is what tells them apart.
  it("tells a recyclable no from a permanent disqualification without changing the coarse class", async () => {
    const recyclable = scopeWithKind("lead_not_interested", false);
    const permanent = scopeWithKind("lead_changed_job", true);

    expect(recyclable.replyClassification).toBe("negative");
    expect(permanent.replyClassification).toBe("negative");

    mockBothProviders(
      [
        {
          email: "john@acme.com",
          byCampaign: { camp_1: recyclable, camp_2: permanent },
          campaign: null,
          brand: permanent,
          global: emptyGlobal,
        },
      ],
      [],
    );

    const res = await authedPost("/orgs/status").send({
      brandId: "brand_1",
      items: [{ email: "john@acme.com" }],
    });

    const byCampaign = res.body.results[0].broadcast.byCampaign;
    expect(byCampaign.camp_1.replyClassification).toBe("negative");
    expect(byCampaign.camp_1.disqualified).toBe(false);
    expect(byCampaign.camp_2.replyClassification).toBe("negative");
    expect(byCampaign.camp_2.disqualified).toBe(true);
  });

  // AC3 — the vocabulary is instantly-service's. A kind this gateway has never
  // seen must reach the caller untouched, never be dropped or refused.
  it.each([
    "lead_interested",
    "lead_referral",
    "lead_info_requested",
    "lead_meeting_requested",
    "lead_not_interested",
    "lead_wrong_person",
    "lead_changed_job",
    "lead_neutral",
    "lead_out_of_office",
    "auto_reply_received",
    "lead_kind_this_gateway_has_never_seen",
  ])("forwards reply kind %s untouched", async (replyKind) => {
    mockBothProviders(
      [
        {
          email: "john@acme.com",
          byCampaign: null,
          campaign: scopeWithKind(replyKind, false),
          brand: null,
          global: emptyGlobal,
        },
      ],
      [],
    );

    const res = await authedPost("/orgs/status").send({
      campaignId: "camp_1",
      items: [{ email: "john@acme.com" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].broadcast.campaign.replyKind).toBe(replyKind);
  });

  // AC2 — purely additive: a provider that omits the fields is unaffected.
  it("leaves a scope without the fields exactly as it was", async () => {
    mockBothProviders(
      [
        {
          email: "john@acme.com",
          byCampaign: null,
          campaign: deliveredScope,
          brand: null,
          global: emptyGlobal,
        },
      ],
      [
        {
          email: "john@acme.com",
          byCampaign: null,
          campaign: emptyScope,
          brand: null,
          global: emptyGlobal,
        },
      ],
    );

    const res = await authedPost("/orgs/status").send({
      campaignId: "camp_1",
      items: [{ email: "john@acme.com" }],
    });

    expect(res.body.results[0].broadcast.campaign).toEqual(deliveredScope);
    expect(res.body.results[0].transactional.campaign).toEqual(emptyScope);
  });
});
