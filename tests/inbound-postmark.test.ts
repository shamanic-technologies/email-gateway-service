import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { verifyRequest } from "../src/lib/hmac";

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
    features: { url: "", apiKey: "" },
    workflow: { url: "", apiKey: "" },
    runs: { url: "", apiKey: "" },
    inboundSubscriptions: [
      {
        name: "journalists-quotes-service:inbound",
        filter: { aliasPattern: "*@inbox.example.com" },
        endpoint_url: "https://jq.example/webhooks/email-gateway/inbound",
        hmac_secret: "jqs-shared-secret",
      },
    ],
  },
}));

import { app } from "../src/index";

const mockFetch = vi.fn();
const originalFetch = global.fetch;

const samplePostmarkInbound = (overrides: Record<string, unknown> = {}) => ({
  RecordType: "Inbound",
  MessageID: "pm-inbound-1",
  From: "journalist@source.com",
  To: "haro@inbox.example.com",
  ToFull: [{ Email: "haro@inbox.example.com", Name: "HARO", MailboxHash: "" }],
  Subject: "Quote opportunity",
  TextBody: "Need a quote on AI",
  HtmlBody: "<p>Need a quote on AI</p>",
  ...overrides,
});

describe("POST /inbound/postmark", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("rejects requests without x-api-key (401)", async () => {
    const res = await request(app).post("/inbound/postmark").send(samplePostmarkInbound());
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects requests with wrong x-api-key (401)", async () => {
    const res = await request(app)
      .post("/inbound/postmark")
      .set("x-api-key", "wrong")
      .send(samplePostmarkInbound());
    expect(res.status).toBe(401);
  });

  it("fans out signed POST to matching subscriber and returns 200", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve("ok") });
    const payload = samplePostmarkInbound();

    const res = await request(app)
      .post("/inbound/postmark")
      .set("x-api-key", "test-api-key")
      .send(payload);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://jq.example/webhooks/email-gateway/inbound");
    expect(opts.method).toBe("POST");
    expect(opts.headers["content-type"]).toBe("application/json");
    expect(opts.headers["idempotency-key"]).toBe("pm-inbound-1");
    expect(opts.headers["x-eg-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(opts.body)).toEqual(payload);

    const verified = verifyRequest(opts.headers["x-eg-signature"], opts.body, "jqs-shared-secret");
    expect(verified.valid).toBe(true);
  });

  it("returns 502 when subscriber returns 500 (fail loud → Postmark retries)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("boom"),
    });

    const res = await request(app)
      .post("/inbound/postmark")
      .set("x-api-key", "test-api-key")
      .send(samplePostmarkInbound());

    expect(res.status).toBe(502);
    expect(res.body.subscription).toBe("journalists-quotes-service:inbound");
    expect(res.body.upstream_status).toBe(500);
    errSpy.mockRestore();
  });

  it("returns 502 on subscriber network error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await request(app)
      .post("/inbound/postmark")
      .set("x-api-key", "test-api-key")
      .send(samplePostmarkInbound());

    expect(res.status).toBe(502);
    expect(res.body.subscription).toBe("journalists-quotes-service:inbound");
    expect(res.body.upstream_status).toBeNull();
    errSpy.mockRestore();
  });

  it("returns 200 and skips fan-out when no subscription alias matches", async () => {
    const res = await request(app)
      .post("/inbound/postmark")
      .set("x-api-key", "test-api-key")
      .send(samplePostmarkInbound({ To: "stranger@unknown.com", ToFull: [{ Email: "stranger@unknown.com" }] }));

    expect(res.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 200 and skips fan-out on non-inbound RecordType", async () => {
    const res = await request(app)
      .post("/inbound/postmark")
      .set("x-api-key", "test-api-key")
      .send({ RecordType: "Delivery", MessageID: "x" });

    expect(res.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 500 on inbound payload missing MessageID", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .post("/inbound/postmark")
      .set("x-api-key", "test-api-key")
      .send({ RecordType: "Inbound", To: "haro@inbox.example.com" });

    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});

describe("POST /webhooks/postmark (legacy proxy, no inbound dispatch)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("forwards body to upstream postmark-service, does NOT dispatch inbound", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const res = await request(app)
      .post("/webhooks/postmark")
      .send({
        RecordType: "Inbound",
        MessageID: "pm-1",
        To: "haro@inbox.example.com",
        ToFull: [{ Email: "haro@inbox.example.com" }],
      });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("localhost:3010");
  });
});
