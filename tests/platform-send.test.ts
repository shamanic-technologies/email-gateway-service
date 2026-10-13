import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";
import * as idempotencyStore from "../src/lib/idempotency-store";
import { PLATFORM_SEND_PATH } from "../src/lib/postmark-client";

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

const mockFetch = vi.fn();
global.fetch = mockFetch;

function body(overrides = {}) {
  return {
    type: "transactional",
    to: "agent@example.com",
    subject: "Your sign-up code: 482913",
    htmlBody: "<p>482913</p>",
    textBody: "482913",
    tag: "signup-code",
    ...overrides,
  };
}

function post() {
  return request(app).post("/platform/send").set("X-API-Key", "test-api-key");
}

function okPostmark(messageId = "pm-msg-1") {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ success: true, messageId }),
  });
}

describe("POST /platform/send (org-less, platform-paid)", () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await idempotencyStore.clear();
  });

  it("relays to postmark-service's org-less send with NO org/user headers", async () => {
    okPostmark();
    const res = await post().set("x-run-id", "run-1").send(body());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      provider: "transactional",
      payer: "platform",
      messageId: "pm-msg-1",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`http://localhost:3010${PLATFORM_SEND_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Key"]).toBe("pm-key");
    expect(init.headers["x-run-id"]).toBe("run-1");
    expect(init.headers).not.toHaveProperty("x-org-id");
    expect(init.headers).not.toHaveProperty("x-user-id");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({
      to: "agent@example.com",
      subject: "Your sign-up code: 482913",
      tag: "signup-code",
      textBody: "482913",
      payer: "platform",
      stream: "transactional",
    });
    // Sent exactly as given: no Unsubscribe footer on a person-to-person mail.
    expect(sent.htmlBody).toBe("<p>482913</p>");
    expect(sent).not.toHaveProperty("orgId");
  });

  it("refuses a broadcast org-less send with a named 400 and sends nothing", async () => {
    const res = await post().send({ ...body({ type: "broadcast" }), sequence: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("platform_send_transactional_only");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses a request with no type", async () => {
    const { type: _t, ...rest } = body();
    const res = await post().send(rest);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("platform_send_transactional_only");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(["x-org-id", "x-user-id"])("refuses %s on an org-less send", async (header) => {
    const res = await post().set(header, "some-id").send(body());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("platform_send_org_identity_refused");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses stream=broadcast (org-less is transactional stream only)", async () => {
    const res = await post().send(body({ stream: "broadcast" }));
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses a send with no body at all", async () => {
    const res = await post().send(body({ htmlBody: undefined, textBody: undefined }));
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses an invalid recipient", async () => {
    const res = await post().send(body({ to: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("requires the api key", async () => {
    const res = await request(app).post("/platform/send").send(body());
    expect(res.status).toBe(401);
  });

  it("is loud when postmark-service fails: 502, never a 200", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("boom"),
    });
    const res = await post().send(body());
    expect(res.status).toBe(502);
  });

  it("is loud when postmark-service answers 2xx without a messageId", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: false }) });
    const res = await post().send(body());
    expect(res.status).toBe(502);
  });

  it("dedups on idempotencyKey", async () => {
    okPostmark();
    const first = await post().send(body({ idempotencyKey: "k1" }));
    const second = await post().send(body({ idempotencyKey: "k1" }));
    expect(first.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("POST /orgs/send payer passthrough", () => {
  beforeEach(() => mockFetch.mockReset());

  function orgPost() {
    return request(app).post("/orgs/send").set("X-API-Key", "test-api-key").set("x-org-id", "org_1");
  }

  it("forwards payer=platform on an org-bearing transactional send", async () => {
    okPostmark();
    const res = await orgPost().send(body({ payer: "platform" }));
    expect(res.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3010/orgs/send");
    expect(JSON.parse(init.body).payer).toBe("platform");
    expect(init.headers["x-org-id"]).toBe("org_1");
  });

  it("forwards no payer key when omitted (unchanged default)", async () => {
    okPostmark();
    await orgPost().send(body());
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty("payer");
  });

  it("refuses payer on a broadcast send", async () => {
    const res = await orgPost().send({
      type: "broadcast",
      to: "lead@example.com",
      subject: "Hi",
      sequence: [{ step: 1, bodyHtml: "<p>Hi</p>", daysSinceLastStep: 0 }],
      payer: "platform",
    });
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
