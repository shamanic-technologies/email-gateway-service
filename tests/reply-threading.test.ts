import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";
import * as idempotencyStore from "../src/lib/idempotency-store";

// REP-REPLY-1127: several Reply-To addresses + threading headers reach the
// delivered transactional email (postmark-service sets Postmark ReplyTo from
// `replyTo` and every entry of `headers` as a real message header).

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
    google: { url: "http://localhost:3012", apiKey: "google-key" },
    key: { url: "", apiKey: "" },
    runs: { url: "", apiKey: "" },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function tx(overrides: Record<string, unknown> = {}) {
  return {
    type: "transactional",
    to: "rep@client.com",
    subject: "A prospect answered",
    htmlBody: "<p>Hi</p>",
    stream: "transactional",
    ...overrides,
  };
}

function post(body: unknown) {
  return request(app)
    .post("/orgs/send")
    .set("X-API-Key", "test-api-key")
    .set("x-org-id", "org_1")
    .set("x-brand-id", "brand_1")
    .send(body as object);
}

function okSend() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ success: true, messageId: "pm_1" }),
  });
}

function postmarkBody() {
  return JSON.parse(mockFetch.mock.calls[0][1].body);
}

describe("REP-REPLY-1127: several Reply-To addresses", () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await idempotencyStore.clear();
  });

  it("a list of addresses is rendered as one RFC 5322 Reply-To, display names quoted", async () => {
    okSend();
    const res = await post(
      tx({
        replyTo: [
          { name: "Jean Müller", email: "p@x.ch" },
          { name: "Kevin Lourd", email: "kevin@ourdomain.com" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(postmarkBody().replyTo).toBe(
      `=?UTF-8?B?${Buffer.from("Jean Müller").toString("base64")}?= <p@x.ch>, "Kevin Lourd" <kevin@ourdomain.com>`,
    );
  });

  it("an entry without a name is the bare address; a comma in a name stays inside its quotes", async () => {
    okSend();
    await post(tx({ replyTo: [{ email: "p@x.ch" }, { name: "Lourd, Kevin", email: "k@o.com" }] }));
    expect(postmarkBody().replyTo).toBe('p@x.ch, "Lourd, Kevin" <k@o.com>');
  });

  it("a single address string is forwarded verbatim, as before", async () => {
    okSend();
    await post(tx({ replyTo: "prospect@acme.com" }));
    expect(postmarkBody().replyTo).toBe("prospect@acme.com");
  });

  it.each([
    ["an empty list", []],
    ["a malformed address", [{ email: "not-an-email" }]],
    ["a name with a line break", [{ name: "Evil\r\nBcc: x@y.com", email: "p@x.ch" }]],
    ["a name with a double quote", [{ name: 'Kev "K"', email: "p@x.ch" }]],
    ["a name with a backslash", [{ name: "Kev \\ K", email: "p@x.ch" }]],
    ["more than 10 addresses", Array.from({ length: 11 }, (_, i) => ({ email: `a${i}@x.com` }))],
  ])("refuses %s with a 400, nothing sent", async (_label, replyTo) => {
    const res = await post(tx({ replyTo }));
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a broadcast send refuses a list (transactional only)", async () => {
    const res = await post({
      type: "broadcast",
      to: "lead@example.com",
      subject: "Hello",
      sequence: [{ step: 1, bodyHtml: "<p>Hi</p>", daysSinceLastStep: 0 }],
      replyTo: [{ email: "p@x.ch" }],
    });
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("REP-REPLY-1127: In-Reply-To + References become real headers", () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await idempotencyStore.clear();
  });

  it("both are forwarded as postmark-service `headers`, never as body keys it would drop", async () => {
    okSend();
    await post(
      tx({
        inReplyTo: "<reply-2@mail.x.ch>",
        references: "<first-1@ourdomain.com>   <reply-2@mail.x.ch>",
      }),
    );
    const body = postmarkBody();
    expect(body.headers).toEqual([
      { name: "In-Reply-To", value: "<reply-2@mail.x.ch>" },
      { name: "References", value: "<first-1@ourdomain.com> <reply-2@mail.x.ch>" },
    ]);
    expect(body).not.toHaveProperty("inReplyTo");
    expect(body).not.toHaveProperty("references");
  });

  it("only one of them = only that header", async () => {
    okSend();
    await post(tx({ inReplyTo: "<a@b>" }));
    expect(postmarkBody().headers).toEqual([{ name: "In-Reply-To", value: "<a@b>" }]);
  });

  it.each([
    ["a bare id", "first-1@ourdomain.com"],
    ["a line break", "<a@b>\r\nBcc: x@y.com"],
    ["an empty string", ""],
  ])("references with %s is refused 400, nothing sent", async (_label, references) => {
    const res = await post(tx({ references }));
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a caller stating neither: no headers, no replyTo, no threading keys on the wire", async () => {
    okSend();
    await post(tx());
    const body = postmarkBody();
    expect(body).not.toHaveProperty("headers");
    expect(body).not.toHaveProperty("replyTo");
    expect(body).not.toHaveProperty("inReplyTo");
    expect(body).not.toHaveProperty("references");
  });
});
