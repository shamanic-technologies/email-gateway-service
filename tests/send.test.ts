import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";
import { buildSignature, appendSignature, buildDefaultFooter } from "../src/lib/signature";
import * as idempotencyStore from "../src/lib/idempotency-store";

// Mock provider registration to no-op (tested separately)
vi.mock("../src/lib/register-providers", () => ({
  registerProviderRequirements: vi.fn().mockResolvedValue(undefined),
}));

// Mock config - vi.mock is hoisted, so use literal values
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

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function buildBroadcastBody(overrides = {}) {
  return {
    type: "broadcast",
    campaignId: "campaign_1",
    workflowSlug: "test-workflow",
    to: "lead@example.com",
    recipientFirstName: "Jane",
    recipientLastName: "Doe",
    recipientCompany: "Acme Corp",
    subject: "Hello",
    sequence: [
      { step: 1, bodyHtml: "<p>Hi</p>", bodyText: "Hi", daysSinceLastStep: 0 },
      { step: 2, bodyHtml: "<p>Following up</p>", bodyText: "Following up", daysSinceLastStep: 3 },
      { step: 3, bodyHtml: "<p>Final email</p>", bodyText: "Final email", daysSinceLastStep: 7 },
    ],
    ...overrides,
  };
}

function buildTransactionalBody(overrides = {}) {
  return {
    type: "transactional",
    campaignId: "campaign_1",
    workflowSlug: "test-workflow",
    to: "user@example.com",
    recipientFirstName: "John",
    recipientLastName: "Smith",
    recipientCompany: "Corp Inc",
    subject: "Welcome",
    htmlBody: "<p>Welcome</p>",
    ...overrides,
  };
}

function authedPost(path: string) {
  return request(app)
    .post(path)
    .set("X-API-Key", API_KEY)
    .set("x-org-id", "org_1")
    .set("x-brand-id", "brand_1");
}

describe("POST /orgs/send", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    idempotencyStore.clear();
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

      const res = await authedPost("/orgs/send").send(buildBroadcastBody());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        provider: "broadcast",
        messageId: "lead_456",
        campaignId: "inst_camp_123",
      });
    });

    it("returns 200 with deduplicated flag when added === 0 (duplicate lead)", async () => {
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

      const res = await authedPost("/orgs/send").send(buildBroadcastBody());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deduplicated).toBe(true);
      expect(res.body.campaignId).toBe("inst_camp_123");
    });

    it("retries on timeout with a fresh AbortSignal", async () => {
      // First call: simulate a network timeout (AbortError)
      mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
      // Retry: succeed
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      const res = await authedPost("/orgs/send").send(buildBroadcastBody());

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Verify each call got its own signal (not the same object)
      const signal1 = mockFetch.mock.calls[0][1].signal;
      const signal2 = mockFetch.mock.calls[1][1].signal;
      expect(signal1).not.toBe(signal2);
    });

    it("retries on timeout with a fresh AbortSignal (transactional)", async () => {
      // First postmark call: timeout
      mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
      // Retry: succeed
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_retry" }),
      });

      const res = await authedPost("/orgs/send").send(buildTransactionalBody());

      expect(res.status).toBe(200);
      expect(res.body.messageId).toBe("pm_retry");
    });

    it("returns 502 when instantly-service is down", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      const res = await authedPost("/orgs/send").send(buildBroadcastBody());

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Upstream service error");
    });

    it("passes correct payload with sequence to instantly-service", async () => {
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

      await authedPost("/orgs/send").send(
        buildBroadcastBody({
          metadata: { source: "test" },
        })
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3011/orgs/send");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body);
      expect(body.to).toBe("lead@example.com");
      expect(body.firstName).toBe("Jane");
      expect(body.lastName).toBe("Doe");
      expect(body.company).toBe("Acme Corp");
      expect(body.subject).toBe("Hello");
      expect(body.sequence).toEqual([
        { step: 1, bodyHtml: "<p>Hi</p>", bodyText: "Hi", daysSinceLastStep: 0 },
        { step: 2, bodyHtml: "<p>Following up</p>", bodyText: "Following up", daysSinceLastStep: 3 },
        { step: 3, bodyHtml: "<p>Final email</p>", bodyText: "Final email", daysSinceLastStep: 7 },
      ]);
      expect(body.email).toBeUndefined();
      expect(body.variables).toEqual({ source: "test" });
      // orgId, campaignId, brandId, workflowSlug now go via headers, not body
      expect(body.orgId).toBeUndefined();
      expect(body.campaignId).toBeUndefined();
      expect(body.brandId).toBeUndefined();
      expect(body.workflowSlug).toBeUndefined();
      expect(body.appId).toBeUndefined();
      expect(body.parentRunId).toBeUndefined();
    });

    it("forwards identity headers to instantly-service", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await authedPost("/orgs/send")
        .set("x-user-id", "user_1")
        .set("x-run-id", "run_1")
        .send(buildBroadcastBody());

      const instantlyHeaders = mockFetch.mock.calls[0][1].headers;
      expect(instantlyHeaders["x-org-id"]).toBe("org_1");
      expect(instantlyHeaders["x-user-id"]).toBe("user_1");
      expect(instantlyHeaders["x-run-id"]).toBe("run_1");
    });

    it("forwards sequence as-is for broadcast (no signature, no brand fetch)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await authedPost("/orgs/send").send(buildBroadcastBody());

      // Only 1 fetch call (instantly), no brand service
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.sequence).toHaveLength(3);
      expect(body.sequence[0].bodyHtml).toBe("<p>Hi</p>");
      expect(body.email).toBeUndefined();
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

      const res = await authedPost("/orgs/send").send(buildTransactionalBody());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        provider: "transactional",
        messageId: "pm_msg_789",
      });
    });

    it("uses custom from when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_2" }),
      });

      await authedPost("/orgs/send").send(buildTransactionalBody({ from: "Custom <custom@example.com>" }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.from).toBe("Custom <custom@example.com>");
    });

    it("does not inject a from when omitted (downstream resolves it)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_3" }),
      });

      await authedPost("/orgs/send").send(buildTransactionalBody());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.from).toBeUndefined();
    });

    it("does not send messageStream to postmark-service (resolved server-side)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_4" }),
      });

      await authedPost("/orgs/send").send(buildTransactionalBody());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messageStream).toBeUndefined();
    });

    it("appends default unsubscribe for transactional", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await authedPost("/orgs/send").send(buildTransactionalBody());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.htmlBody).toContain("{{{pm:unsubscribe}}}");
      expect(body.htmlBody).not.toContain("Kevin Lourd");
      expect(body.htmlBody).not.toContain("growthagency.dev");
    });

    it("forwards orgId from headers to postmark-service", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await authedPost("/orgs/send").send(buildTransactionalBody());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.orgId).toBe("org_1");
      expect(body.appId).toBeUndefined();
      expect(body.parentRunId).toBeUndefined();
    });

    it("forwards identity headers to postmark-service when present", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await authedPost("/orgs/send")
        .set("x-user-id", "user_1")
        .set("x-run-id", "run_1")
        .send(buildTransactionalBody());

      const postmarkHeaders = mockFetch.mock.calls[0][1].headers;
      expect(postmarkHeaders["x-org-id"]).toBe("org_1");
      expect(postmarkHeaders["x-user-id"]).toBe("user_1");
      expect(postmarkHeaders["x-run-id"]).toBe("run_1");
    });
  });

  describe("idempotency", () => {
    it("returns cached result on duplicate idempotencyKey (transactional)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_msg_1" }),
      });

      const body = buildTransactionalBody({ idempotencyKey: "idem_1" });

      const res1 = await authedPost("/orgs/send").send(body);

      expect(res1.status).toBe(200);
      expect(res1.body.messageId).toBe("pm_msg_1");
      expect(res1.body.deduplicated).toBeUndefined();

      // Second call with same key — should NOT call fetch again
      const res2 = await authedPost("/orgs/send").send(body);

      expect(res2.status).toBe(200);
      expect(res2.body.messageId).toBe("pm_msg_1");
      expect(res2.body.deduplicated).toBe(true);
      // Only 1 fetch call total (postmark from first request)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns cached result on duplicate idempotencyKey (broadcast)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      const body = buildBroadcastBody({ idempotencyKey: "idem_2" });

      const res1 = await authedPost("/orgs/send").send(body);

      expect(res1.status).toBe(200);
      expect(res1.body.campaignId).toBe("c1");
      expect(res1.body.deduplicated).toBeUndefined();

      const res2 = await authedPost("/orgs/send").send(body);

      expect(res2.status).toBe(200);
      expect(res2.body.campaignId).toBe("c1");
      expect(res2.body.deduplicated).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("caches 200 responses for broadcast duplicates (added=0)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: null, added: 0 }),
      });

      const body = buildBroadcastBody({ idempotencyKey: "idem_dedup" });

      const res1 = await authedPost("/orgs/send").send(body);

      expect(res1.status).toBe(200);
      expect(res1.body.deduplicated).toBe(true);

      const res2 = await authedPost("/orgs/send").send(body);

      expect(res2.status).toBe(200);
      expect(res2.body.deduplicated).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("sends normally when different idempotencyKeys are used", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_msg_1" }),
      });

      const res1 = await authedPost("/orgs/send")
        .send(buildTransactionalBody({ idempotencyKey: "key_a" }));

      const res2 = await authedPost("/orgs/send")
        .send(buildTransactionalBody({ idempotencyKey: "key_b" }));

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      // 1 call per request: postmark only
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("sends normally when no idempotencyKey is provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_msg_1" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_msg_2" }),
      });

      const body = buildTransactionalBody();

      const res1 = await authedPost("/orgs/send").send(body);

      const res2 = await authedPost("/orgs/send").send(body);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.deduplicated).toBeUndefined();
      expect(res2.body.deduplicated).toBeUndefined();
      // Both requests hit postmark
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does not cache upstream errors (502)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      const body = buildTransactionalBody({ idempotencyKey: "idem_err" });

      const res1 = await authedPost("/orgs/send").send(body);

      expect(res1.status).toBe(502);

      // Retry should actually attempt to send again
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_retry" }),
      });

      const res2 = await authedPost("/orgs/send").send(body);

      expect(res2.status).toBe(200);
      expect(res2.body.messageId).toBe("pm_retry");
      expect(res2.body.deduplicated).toBeUndefined();
    });
  });

  describe("workflowSlug forwarding", () => {
    it("does not forward workflowSlug in body to instantly-service for broadcast (uses headers)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await authedPost("/orgs/send")
        .set("x-workflow-slug", "outreach-v2")
        .send(buildBroadcastBody({ workflowSlug: "outreach-v2" }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.workflowSlug).toBeUndefined();
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-workflow-slug"]).toBe("outreach-v2");
    });

    it("forwards workflowSlug to postmark-service for transactional", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await authedPost("/orgs/send").send(buildTransactionalBody({ workflowSlug: "welcome-flow" }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.workflowSlug).toBe("welcome-flow");
    });
  });

  describe("leadId forwarding", () => {
    it("forwards leadId to instantly-service for broadcast", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await authedPost("/orgs/send").send(buildBroadcastBody({ leadId: "lead_abc" }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.leadId).toBe("lead_abc");
    });

    it("forwards leadId to postmark-service for transactional", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await authedPost("/orgs/send").send(buildTransactionalBody({ leadId: "lead_xyz" }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.leadId).toBe("lead_xyz");
    });

    it("works without leadId (optional field)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      const res = await authedPost("/orgs/send").send(buildBroadcastBody());

      expect(res.status).toBe(200);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.leadId).toBeUndefined();
    });
  });

  describe("validation", () => {
    it("returns 400 for missing required fields", async () => {
      const res = await authedPost("/orgs/send").send({ type: "broadcast" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid request");
    });

    it("accepts request without workflowSlug (optional)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      const { workflowSlug, ...bodyWithout } = buildBroadcastBody();
      const res = await authedPost("/orgs/send").send(bodyWithout);

      expect(res.status).toBe(200);
    });

    it("returns explicit error when to is null (lead has no email)", async () => {
      const res = await authedPost("/orgs/send").send(buildBroadcastBody({ to: null }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid request");
      expect(res.body.details.fieldErrors.to[0]).toContain(
        "the lead has no email address"
      );
    });

    it("returns explicit error when recipientLastName is missing", async () => {
      const { recipientLastName, ...body } = buildBroadcastBody();
      const res = await authedPost("/orgs/send").send(body);

      expect(res.status).toBe(400);
      expect(res.body.details.fieldErrors.recipientLastName[0]).toContain(
        "recipientLastName is required"
      );
    });

    it("returns 401 without API key", async () => {
      const res = await request(app)
        .post("/orgs/send")
        .send(buildBroadcastBody());

      expect(res.status).toBe(401);
    });

    it("returns 400 when x-org-id header is missing", async () => {
      const res = await request(app)
        .post("/orgs/send")
        .set("X-API-Key", API_KEY)
        .send(buildBroadcastBody());

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("x-org-id");
    });

    it("works without x-user-id header (optional)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      const res = await request(app)
        .post("/orgs/send")
        .set("X-API-Key", API_KEY)
        .set("x-org-id", "org_1")
        .send(buildTransactionalBody());

      expect(res.status).toBe(200);
    });

    it("works without x-run-id header (optional)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      const res = await request(app)
        .post("/orgs/send")
        .set("X-API-Key", API_KEY)
        .set("x-org-id", "org_1")
        .set("x-user-id", "user_1")
        .send(buildTransactionalBody());

      expect(res.status).toBe(200);
    });
  });

  describe("tracking headers (x-campaign-id, x-brand-id, x-workflow-slug, x-feature-slug)", () => {
    function authedPostWithTracking(path: string) {
      return authedPost(path)
        .set("x-campaign-id", "hdr_campaign")
        .set("x-brand-id", "hdr_brand")
        .set("x-workflow-slug", "hdr_workflow")
        .set("x-feature-slug", "hdr_feature");
    }

    it("forwards tracking headers to instantly-service for broadcast", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await authedPostWithTracking("/orgs/send").send(buildBroadcastBody());

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-campaign-id"]).toBe("hdr_campaign");
      expect(headers["x-brand-id"]).toBe("hdr_brand");
      expect(headers["x-workflow-slug"]).toBe("hdr_workflow");
      expect(headers["x-feature-slug"]).toBe("hdr_feature");
    });

    it("forwards tracking headers to postmark-service for transactional", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await authedPostWithTracking("/orgs/send").send(buildTransactionalBody());

      const postmarkHeaders = mockFetch.mock.calls[0][1].headers;
      expect(postmarkHeaders["x-campaign-id"]).toBe("hdr_campaign");
      expect(postmarkHeaders["x-brand-id"]).toBe("hdr_brand");
      expect(postmarkHeaders["x-workflow-slug"]).toBe("hdr_workflow");
      expect(postmarkHeaders["x-feature-slug"]).toBe("hdr_feature");
    });

    it("does not include brandId/campaignId/workflowSlug in body for broadcast (headers only)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      const { campaignId, workflowSlug, ...bodyWithout } = buildBroadcastBody();
      await authedPostWithTracking("/orgs/send").send(bodyWithout);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.brandId).toBeUndefined();
      expect(body.campaignId).toBeUndefined();
      expect(body.workflowSlug).toBeUndefined();
      // These are forwarded via headers instead
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-campaign-id"]).toBe("hdr_campaign");
      expect(headers["x-brand-id"]).toBe("hdr_brand");
      expect(headers["x-workflow-slug"]).toBe("hdr_workflow");
    });

    it("uses header values as fallback when body fields are missing (transactional)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      const { campaignId, workflowSlug, ...bodyWithout } = buildTransactionalBody();
      await authedPostWithTracking("/orgs/send").send(bodyWithout);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.brandId).toEqual(["hdr_brand"]);
      expect(body.campaignId).toBe("hdr_campaign");
      expect(body.workflowSlug).toBe("hdr_workflow");
    });

    it("does not pass campaignId/workflowSlug in body even when provided (broadcast)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await authedPostWithTracking("/orgs/send").send(
        buildBroadcastBody({ campaignId: "body_campaign", workflowSlug: "body_workflow" })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.campaignId).toBeUndefined();
      expect(body.workflowSlug).toBeUndefined();
    });

    it("does not pass brandId in body to instantly (forwarded via x-brand-id header)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await authedPost("/orgs/send").send(buildBroadcastBody());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.brandId).toBeUndefined();
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-brand-id"]).toBe("brand_1");
    });

    it("forwards CSV x-brand-id header to instantly (not in body)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await authedPost("/orgs/send")
        .set("x-brand-id", "brand_a,brand_b,brand_c")
        .send(buildBroadcastBody());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.brandId).toBeUndefined();
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-brand-id"]).toBe("brand_a,brand_b,brand_c");
    });
  });

  describe("conditional header forwarding", () => {
    it("only forwards x-org-id when other identity headers are absent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await request(app)
        .post("/orgs/send")
        .set("X-API-Key", API_KEY)
        .set("x-org-id", "org_1")
        .send(buildTransactionalBody());

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-org-id"]).toBe("org_1");
      expect(headers["x-user-id"]).toBeUndefined();
      expect(headers["x-run-id"]).toBeUndefined();
    });
  });

  describe("signature", () => {
    it("appends default unsubscribe for transactional", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
      });

      await authedPost("/orgs/send").send(buildTransactionalBody());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.htmlBody).toContain("{{{pm:unsubscribe}}}");
      expect(body.htmlBody).toContain("Unsubscribe");
      expect(body.htmlBody).not.toContain("Kevin Lourd");
      expect(body.htmlBody).not.toContain("growthagency.dev");
    });

    it("forwards sequence as-is for broadcast (no signature)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, campaignId: "c1", leadId: "l1", added: 1 }),
      });

      await authedPost("/orgs/send").send(buildBroadcastBody());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.sequence).toHaveLength(3);
      expect(body.sequence[0].bodyHtml).toBe("<p>Hi</p>");
      expect(body.email).toBeUndefined();
    });
  });
});

describe("buildSignature", () => {
  it("returns unsubscribe for transactional", () => {
    const sig = buildSignature("transactional");
    expect(sig).toContain("{{{pm:unsubscribe}}}");
    expect(sig).toContain("Unsubscribe");
    expect(sig).not.toContain("Kevin Lourd");
    expect(sig).not.toContain("growthagency.dev");
  });

  it("returns empty string for broadcast", () => {
    const sig = buildSignature("broadcast");
    expect(sig).toBe("");
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
    expect(appendSignature(undefined, "broadcast")).toBeUndefined();
  });

  it("appends unsubscribe for transactional", () => {
    const result = appendSignature("<p>Hello</p>", "transactional");
    expect(result).toContain("<p>Hello</p>");
    expect(result).toContain("{{{pm:unsubscribe}}}");
    expect(result).not.toContain("Kevin Lourd");
  });

  it("returns original htmlBody for broadcast", () => {
    const result = appendSignature("<p>Hello</p>", "broadcast");
    expect(result).toBe("<p>Hello</p>");
  });
});
