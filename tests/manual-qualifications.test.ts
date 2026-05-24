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
    runs: { url: "", apiKey: "" },
  },
}));

const API_KEY = "test-api-key";
const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockJsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function mockTextResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "text/plain"]]),
    text: () => Promise.resolve(body),
  };
}

function authedPost(path: string) {
  return request(app)
    .post(path)
    .set("X-API-Key", API_KEY)
    .set("x-org-id", "org_1");
}

function authedGet(path: string) {
  return request(app)
    .get(path)
    .set("X-API-Key", API_KEY)
    .set("x-org-id", "org_1");
}

const SAMPLE_QUALIFICATION = {
  id: "qual_1",
  orgId: "org_1",
  campaignId: "camp_1",
  instantlyCampaignId: "inst_camp_1",
  email: "alice@media.com",
  status: "lead_interested",
  qualifiedBy: "user_1",
  notes: null,
  qualifiedAt: "2026-05-24T10:00:00.000Z",
};

describe("POST /orgs/manual-qualifications", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 200 with { idempotent, qualification } when instantly accepts", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(200, { idempotent: false, qualification: SAMPLE_QUALIFICATION }),
    );

    const res = await authedPost("/orgs/manual-qualifications").send({
      campaign_id: "camp_1",
      email: "alice@media.com",
      status: "lead_interested",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ idempotent: false, qualification: SAMPLE_QUALIFICATION });
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/orgs/manual-qualifications")
      .send({ campaign_id: "camp_1", email: "alice@media.com", status: "lead_interested" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const res = await request(app)
      .post("/orgs/manual-qualifications")
      .set("X-API-Key", API_KEY)
      .send({ campaign_id: "camp_1", email: "alice@media.com", status: "lead_interested" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("round-trips upstream 400 (missing x-user-id) byte-equal", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(400, { error: "x-user-id header is required" }),
    );

    const res = await authedPost("/orgs/manual-qualifications").send({
      campaign_id: "camp_1",
      email: "alice@media.com",
      status: "lead_interested",
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "x-user-id header is required" });
  });

  it("returns 400 for invalid status enum (local Zod)", async () => {
    const res = await authedPost("/orgs/manual-qualifications")
      .set("x-user-id", "user_1")
      .send({
        campaign_id: "camp_1",
        email: "alice@media.com",
        status: "not_a_real_status",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 400 for missing required field (local Zod)", async () => {
    const res = await authedPost("/orgs/manual-qualifications")
      .set("x-user-id", "user_1")
      .send({ campaign_id: "camp_1", status: "lead_interested" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("round-trips upstream 404 (campaign/email not in org) byte-equal", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(404, { error: "Campaign not found for this org and email" }),
    );

    const res = await authedPost("/orgs/manual-qualifications").send({
      campaign_id: "camp_1",
      email: "alice@media.com",
      status: "lead_interested",
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Campaign not found for this org and email" });
  });

  it("returns 502 on upstream 5xx", async () => {
    mockFetch.mockResolvedValueOnce(mockTextResponse(500, "Internal Server Error"));

    const res = await authedPost("/orgs/manual-qualifications").send({
      campaign_id: "camp_1",
      email: "alice@media.com",
      status: "lead_interested",
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Upstream service error");
  });

  it("forwards identity headers to instantly-service", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(200, { idempotent: false, qualification: SAMPLE_QUALIFICATION }),
    );

    await authedPost("/orgs/manual-qualifications")
      .set("x-user-id", "user_1")
      .set("x-run-id", "run_1")
      .set("x-campaign-id", "hdr_camp")
      .send({
        campaign_id: "camp_1",
        email: "alice@media.com",
        status: "lead_interested",
      });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org_1");
    expect(headers["x-user-id"]).toBe("user_1");
    expect(headers["x-run-id"]).toBe("run_1");
    expect(headers["x-campaign-id"]).toBe("hdr_camp");
  });

  it("URL byte-equal + body byte-identical to instantly-service", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(200, { idempotent: true, qualification: SAMPLE_QUALIFICATION }),
    );

    const body = {
      campaign_id: "camp_1",
      email: "alice@media.com",
      status: "lead_interested",
      notes: "Reply received on Gmail",
    };

    await authedPost("/orgs/manual-qualifications").send(body);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3011/orgs/manual-qualifications");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual(body);
  });

  it("accepts all 8 status enum values", async () => {
    const statuses = [
      "lead_interested",
      "lead_meeting_booked",
      "lead_closed",
      "lead_not_interested",
      "lead_wrong_person",
      "lead_neutral",
      "lead_out_of_office",
      "auto_reply_received",
    ];

    for (const status of statuses) {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse(200, { idempotent: false, qualification: { ...SAMPLE_QUALIFICATION, status } }),
      );

      const res = await authedPost("/orgs/manual-qualifications").send({
        campaign_id: "camp_1",
        email: "alice@media.com",
        status,
      });

      expect(res.status).toBe(200);
    }
  });
});

describe("GET /orgs/manual-qualifications", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 200 with qualifications array", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(200, { qualifications: [SAMPLE_QUALIFICATION] }),
    );

    const res = await authedGet("/orgs/manual-qualifications");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ qualifications: [SAMPLE_QUALIFICATION] });
  });

  it("returns empty array when org has no qualifications", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { qualifications: [] }));

    const res = await authedGet("/orgs/manual-qualifications");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ qualifications: [] });
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/orgs/manual-qualifications");
    expect(res.status).toBe(401);
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const res = await request(app)
      .get("/orgs/manual-qualifications")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("forwards campaign_id, email, limit query params byte-equal", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { qualifications: [] }));

    await authedGet(
      "/orgs/manual-qualifications?campaign_id=camp_1&email=alice%40media.com&limit=50",
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("http://localhost:3011/orgs/manual-qualifications");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("campaign_id")).toBe("camp_1");
    expect(parsed.searchParams.get("email")).toBe("alice@media.com");
    expect(parsed.searchParams.get("limit")).toBe("50");
  });

  it("does not forward unknown query params", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { qualifications: [] }));

    await authedGet("/orgs/manual-qualifications?campaign_id=camp_1&random=hack");

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("campaign_id")).toBe("camp_1");
    expect(parsed.searchParams.get("random")).toBeNull();
  });

  it("forwards no query params when none provided", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { qualifications: [] }));

    await authedGet("/orgs/manual-qualifications");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3011/orgs/manual-qualifications");
  });

  it("forwards identity headers to instantly-service", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { qualifications: [] }));

    await authedGet("/orgs/manual-qualifications")
      .set("x-user-id", "user_1")
      .set("x-run-id", "run_1");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org_1");
    expect(headers["x-user-id"]).toBe("user_1");
    expect(headers["x-run-id"]).toBe("run_1");
  });

  it("URL byte-equal base path", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { qualifications: [] }));

    await authedGet("/orgs/manual-qualifications");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3011/orgs/manual-qualifications");
  });

  it("returns 400 for invalid limit (non-integer)", async () => {
    const res = await authedGet("/orgs/manual-qualifications?limit=abc");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 400 for limit out of range", async () => {
    const res = await authedGet("/orgs/manual-qualifications?limit=9999");

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("round-trips upstream 400 (Zod error from instantly)", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(400, { error: "Invalid query" }));

    const res = await authedGet("/orgs/manual-qualifications?campaign_id=camp_1");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid query" });
  });

  it("returns 502 on upstream 5xx", async () => {
    mockFetch.mockResolvedValueOnce(mockTextResponse(503, "Service Unavailable"));

    const res = await authedGet("/orgs/manual-qualifications");

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Upstream service error");
  });
});
