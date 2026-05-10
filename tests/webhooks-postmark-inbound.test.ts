import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

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
    inboundForwarding: {
      rules: [
        {
          aliasPattern: "*@inbox.example.com",
          consumerUrl: "https://jq.example/webhooks/inbound",
          consumerName: "journalists-quotes-service",
          consumerApiKey: "jq-shared-key",
        },
      ],
    },
  },
}));

import { app } from "../src/index";
import * as inboundDedup from "../src/lib/inbound-dedup";

const mockFetch = vi.fn();
global.fetch = mockFetch;

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

describe("POST /webhooks/postmark — inbound forwarding", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    inboundDedup.clear();
  });

  it("forwards raw inbound payload to consumer URL when alias matches", async () => {
    // First call: postmark-service forward
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    // Second call: consumer forward
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("OK") });

    const payload = samplePostmarkInbound();
    const res = await request(app).post("/webhooks/postmark").send(payload);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [consumerUrl, consumerOpts] = mockFetch.mock.calls[1];
    expect(consumerUrl).toBe("https://jq.example/webhooks/inbound");
    expect(consumerOpts.method).toBe("POST");
    expect(consumerOpts.headers["x-api-key"]).toBe("jq-shared-key");
    expect(consumerOpts.headers["x-service-name"]).toBe("email-gateway-service");
    expect(consumerOpts.headers["x-postmark-message-id"]).toBe("pm-inbound-1");
    expect(consumerOpts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(consumerOpts.body)).toEqual(payload);
  });

  it("does not POST to consumer when no rule matches", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });

    const payload = samplePostmarkInbound({
      To: "stranger@unknown.com",
      ToFull: [{ Email: "stranger@unknown.com" }],
    });
    const res = await request(app).post("/webhooks/postmark").send(payload);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1); // only postmark-service
  });

  it("dedupes second POST with same MessageID — consumer hit only once", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve("OK") });

    const payload = samplePostmarkInbound();

    const res1 = await request(app).post("/webhooks/postmark").send(payload);
    const res2 = await request(app).post("/webhooks/postmark").send(payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Postmark-service forward fires both times (existing behavior).
    // Consumer hit fires only once (dedup on MessageID).
    const consumerCalls = mockFetch.mock.calls.filter(
      ([url]) => typeof url === "string" && url.includes("jq.example")
    );
    expect(consumerCalls).toHaveLength(1);
  });

  it("returns 200 even when consumer returns 500 (consumer failure logged, not propagated)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const res = await request(app).post("/webhooks/postmark").send(samplePostmarkInbound());

    expect(res.status).toBe(200);
    const errCalls = errSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(errCalls).toContain("inbound-forward failed");
    expect(errCalls).toContain("journalists-quotes-service");
    expect(errCalls).toContain("pm-inbound-1");

    errSpy.mockRestore();
  });

  it("returns 200 when consumer fetch throws (network error)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await request(app).post("/webhooks/postmark").send(samplePostmarkInbound());

    expect(res.status).toBe(200);
    errSpy.mockRestore();
  });

  it("non-inbound webhook (RecordType=Delivery) does not trigger consumer forwarding", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });

    const deliveryPayload = {
      RecordType: "Delivery",
      MessageID: "pm-delivery-1",
      Recipient: "recipient@example.com",
    };
    const res = await request(app).post("/webhooks/postmark").send(deliveryPayload);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1); // only postmark-service
  });

  it("postmark-service forward failure → 502 (existing behavior preserved)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Boom"),
    });

    const res = await request(app).post("/webhooks/postmark").send(samplePostmarkInbound());

    expect(res.status).toBe(502);
  });
});
