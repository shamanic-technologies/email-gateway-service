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

function authedPost(path: string) {
  return request(app).post(path).set("X-API-Key", API_KEY).set("x-org-id", "org_1");
}

function authedGet(path: string) {
  return request(app).get(path).set("X-API-Key", API_KEY).set("x-org-id", "org_1");
}

const SAMPLE_OPTOUT = {
  id: "optout_1",
  orgId: "org_1",
  email: "alice@media.com",
  channel: "sms",
  statedBy: "user_1",
  notes: "Texted my mobile asking not to be contacted again",
  statedAt: "2026-09-01T10:00:00.000Z",
  withdrawnAt: null,
  withdrawnBy: null,
};

describe("POST /orgs/opt-outs", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 200 with the upstream record when instantly accepts", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(200, {
        idempotent: false,
        campaignsAffected: 2,
        campaignsStopped: 2,
        optOut: SAMPLE_OPTOUT,
      }),
    );

    const res = await authedPost("/orgs/opt-outs").send({
      email: "alice@media.com",
      channel: "sms",
      notes: "Texted my mobile asking not to be contacted again",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      idempotent: false,
      campaignsAffected: 2,
      campaignsStopped: 2,
      optOut: SAMPLE_OPTOUT,
    });
  });

  it("forwards to instantly-service POST /orgs/opt-outs with the body byte-identical", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(200, {
        idempotent: false,
        campaignsAffected: 0,
        campaignsStopped: 0,
        optOut: SAMPLE_OPTOUT,
      }),
    );

    await authedPost("/orgs/opt-outs").send({
      email: "alice@media.com",
      channel: "forwarded_thread",
      notes: "Replied to a thread a colleague forwarded",
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3011/orgs/opt-outs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      email: "alice@media.com",
      channel: "forwarded_thread",
      notes: "Replied to a thread a colleague forwarded",
    });
  });

  // AC3 — a channel instantly-service accepts is never refused here. The
  // vocabulary is upstream's; this hop must not hold a stale copy of the enum.
  it.each([
    "sms",
    "phone_call",
    "email_reply",
    "forwarded_thread",
    "in_person",
    "web_form",
    "other",
    "carrier_pigeon_this_gateway_has_never_seen",
  ])("accepts channel %s and forwards it unchanged", async (channel) => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(200, {
        idempotent: false,
        campaignsAffected: 0,
        campaignsStopped: 0,
        optOut: { ...SAMPLE_OPTOUT, channel },
      }),
    );

    const res = await authedPost("/orgs/opt-outs").send({ email: "alice@media.com", channel });

    expect(res.status).toBe(200);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).channel).toBe(channel);
    expect(res.body.optOut.channel).toBe(channel);
  });

  it("round-trips an upstream 400 refusal with its own status and body", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(400, { error: "Invalid channel", details: "not a known channel" }),
    );

    const res = await authedPost("/orgs/opt-outs").send({
      email: "alice@media.com",
      channel: "not_a_channel",
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid channel", details: "not a known channel" });
  });

  it("returns 400 without forwarding when email is missing", async () => {
    const res = await authedPost("/orgs/opt-outs").send({ channel: "sms" });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/orgs/opt-outs")
      .set("x-org-id", "org_1")
      .send({ email: "alice@media.com", channel: "sms" });

    expect(res.status).toBe(401);
  });

  it("returns 400 without x-org-id", async () => {
    const res = await request(app)
      .post("/orgs/opt-outs")
      .set("X-API-Key", API_KEY)
      .send({ email: "alice@media.com", channel: "sms" });

    expect(res.status).toBe(400);
  });

  it("surfaces an upstream 500 as 502", async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(500, { error: "boom" }));

    const res = await authedPost("/orgs/opt-outs").send({
      email: "alice@media.com",
      channel: "sms",
    });

    expect(res.status).toBe(502);
  });
});

describe("POST /orgs/opt-outs/withdrawals", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 200 with the withdrawn record", async () => {
    const withdrawn = {
      ...SAMPLE_OPTOUT,
      withdrawnAt: "2026-09-02T09:00:00.000Z",
      withdrawnBy: "user_2",
    };
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(200, { campaignsAffected: 2, optOut: withdrawn }),
    );

    const res = await authedPost("/orgs/opt-outs/withdrawals").send({
      email: "alice@media.com",
      notes: "Recorded on the wrong lead",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ campaignsAffected: 2, optOut: withdrawn });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3011/orgs/opt-outs/withdrawals");
    expect(JSON.parse(init.body)).toEqual({
      email: "alice@media.com",
      notes: "Recorded on the wrong lead",
    });
  });

  it("round-trips the 404 refusal code byte-equal", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(404, {
        error: "Nothing stands for this lead",
        code: "no_standing_optout",
      }),
    );

    const res = await authedPost("/orgs/opt-outs/withdrawals").send({
      email: "alice@media.com",
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "Nothing stands for this lead",
      code: "no_standing_optout",
    });
  });

  it("returns 400 without forwarding when email is missing", async () => {
    const res = await authedPost("/orgs/opt-outs/withdrawals").send({ notes: "oops" });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("GET /orgs/opt-outs", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns the upstream log", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { optOuts: [SAMPLE_OPTOUT] }));

    const res = await authedGet("/orgs/opt-outs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ optOuts: [SAMPLE_OPTOUT] });
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3011/orgs/opt-outs");
  });

  it("forwards email, standing_only and limit as query params", async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { optOuts: [] }));

    await authedGet("/orgs/opt-outs?email=alice@media.com&standing_only=true&limit=50");

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/orgs/opt-outs");
    expect(url.searchParams.get("email")).toBe("alice@media.com");
    expect(url.searchParams.get("standing_only")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("returns 400 on an out-of-range limit without forwarding", async () => {
    const res = await authedGet("/orgs/opt-outs?limit=9000");

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("surfaces an upstream 500 as 502", async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(500, { error: "boom" }));

    const res = await authedGet("/orgs/opt-outs");

    expect(res.status).toBe(502);
  });
});
