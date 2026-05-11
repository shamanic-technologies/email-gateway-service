import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  matchAlias,
  findMatchingSubscriptions,
  parseSubscriptions,
  resolveSubscriptions,
  extractInboundRecipients,
  extractMessageId,
  isInboundPayload,
  deliverToSubscriber,
  dispatchInbound,
  SubscriberDeliveryError,
  type ResolvedSubscription,
} from "../src/lib/inbound-forwarder";
import { verifyRequest } from "../src/lib/hmac";

describe("matchAlias", () => {
  it("wildcard suffix matches subdomain alias", () => {
    expect(matchAlias("*@inbox.example.com", "haro@inbox.example.com")).toBe(true);
  });

  it("exact match", () => {
    expect(matchAlias("haro@inbox.example.com", "haro@inbox.example.com")).toBe(true);
  });

  it("wildcard does not match different domain", () => {
    expect(matchAlias("*@inbox.example.com", "foo@bar.com")).toBe(false);
  });

  it("case-insensitive matching", () => {
    expect(matchAlias("*@inbox.example.com", "HARO@Inbox.Example.com")).toBe(true);
  });

  it("wildcard requires at least one char before @", () => {
    expect(matchAlias("*@inbox.example.com", "@inbox.example.com")).toBe(false);
  });
});

describe("findMatchingSubscriptions", () => {
  const subs: ResolvedSubscription[] = [
    {
      name: "journalists-quotes-service:inbound",
      filter: { aliasPattern: "*@inbox.example.com" },
      endpoint_url: "https://jq/webhook",
      hmac_secret: "jq-secret",
    },
    {
      name: "other:inbound",
      filter: { aliasPattern: "noreply@notifications.example.com" },
      endpoint_url: "https://other/webhook",
      hmac_secret: "other-secret",
    },
  ];

  it("returns matching subscription for wildcard", () => {
    const matched = findMatchingSubscriptions(subs, ["haro@inbox.example.com"]);
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("journalists-quotes-service:inbound");
  });

  it("empty when no match", () => {
    expect(findMatchingSubscriptions(subs, ["random@unknown.com"])).toEqual([]);
  });

  it("dedupes subscription when multiple recipients match it", () => {
    const matched = findMatchingSubscriptions(subs, [
      "haro@inbox.example.com",
      "qwoted@inbox.example.com",
    ]);
    expect(matched).toHaveLength(1);
  });
});

describe("parseSubscriptions", () => {
  it("parses valid JSON", () => {
    const json = JSON.stringify([
      {
        name: "x",
        filter: { aliasPattern: "*@inbox.example.com" },
        endpoint_url: "https://jq/webhook",
        hmac_secret_env: "JQS_INBOUND_HMAC_SECRET",
      },
    ]);
    const subs = parseSubscriptions(json);
    expect(subs).toHaveLength(1);
    expect(subs[0].name).toBe("x");
  });

  it("empty list when unset", () => {
    expect(parseSubscriptions(undefined)).toEqual([]);
    expect(parseSubscriptions("")).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSubscriptions("{not json")).toThrow();
  });

  it("throws when required field missing", () => {
    const bad = JSON.stringify([
      { filter: { aliasPattern: "*@x.com" }, endpoint_url: "https://x", hmac_secret_env: "S" },
    ]);
    expect(() => parseSubscriptions(bad)).toThrow();
  });
});

describe("resolveSubscriptions", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves hmac_secret_env to actual secret", () => {
    process.env.TEST_INBOUND_SECRET = "shhh";
    const resolved = resolveSubscriptions([
      {
        name: "x",
        filter: { aliasPattern: "*@x.com" },
        endpoint_url: "https://x",
        hmac_secret_env: "TEST_INBOUND_SECRET",
      },
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].hmac_secret).toBe("shhh");
  });

  it("throws when referenced env var is missing", () => {
    delete process.env.MISSING_SECRET;
    expect(() =>
      resolveSubscriptions([
        {
          name: "x",
          filter: { aliasPattern: "*@x.com" },
          endpoint_url: "https://x",
          hmac_secret_env: "MISSING_SECRET",
        },
      ])
    ).toThrow(/MISSING_SECRET/);
  });

  it("throws when referenced env var is empty string", () => {
    process.env.EMPTY_SECRET = "";
    expect(() =>
      resolveSubscriptions([
        {
          name: "x",
          filter: { aliasPattern: "*@x.com" },
          endpoint_url: "https://x",
          hmac_secret_env: "EMPTY_SECRET",
        },
      ])
    ).toThrow();
  });
});

describe("extractInboundRecipients", () => {
  it("returns To as single recipient", () => {
    expect(extractInboundRecipients({ To: "haro@inbox.example.com" })).toEqual([
      "haro@inbox.example.com",
    ]);
  });

  it("returns ToFull[].Email", () => {
    expect(
      extractInboundRecipients({
        ToFull: [{ Email: "a@x.com" }, { Email: "b@x.com" }],
      })
    ).toEqual(["a@x.com", "b@x.com"]);
  });

  it("merges To and ToFull deduplicated", () => {
    const got = extractInboundRecipients({
      To: "haro@inbox.example.com",
      ToFull: [{ Email: "haro@inbox.example.com" }, { Email: "other@x.com" }],
    });
    expect(got.sort()).toEqual(["haro@inbox.example.com", "other@x.com"].sort());
  });
});

describe("isInboundPayload / extractMessageId", () => {
  it("isInboundPayload true only when RecordType=Inbound", () => {
    expect(isInboundPayload({ RecordType: "Inbound" })).toBe(true);
    expect(isInboundPayload({ RecordType: "Delivery" })).toBe(false);
    expect(isInboundPayload({})).toBe(false);
    expect(isInboundPayload(null)).toBe(false);
  });

  it("extractMessageId returns MessageID when string non-empty", () => {
    expect(extractMessageId({ MessageID: "abc" })).toBe("abc");
    expect(extractMessageId({ MessageID: "" })).toBeUndefined();
    expect(extractMessageId({})).toBeUndefined();
  });
});

describe("deliverToSubscriber", () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const sub: ResolvedSubscription = {
    name: "jqs",
    filter: { aliasPattern: "*@inbox.example.com" },
    endpoint_url: "https://jq.example/webhooks/email-gateway/inbound",
    hmac_secret: "test-secret",
  };

  it("POSTs signed body with idempotency-key header", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve("ok") });
    await deliverToSubscriber(sub, { RecordType: "Inbound", MessageID: "msg-1" }, "msg-1", 1700000000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://jq.example/webhooks/email-gateway/inbound");
    expect(opts.method).toBe("POST");
    expect(opts.headers["content-type"]).toBe("application/json");
    expect(opts.headers["idempotency-key"]).toBe("msg-1");

    const signature = opts.headers["x-eg-signature"];
    expect(signature).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    const verified = verifyRequest(signature, opts.body, "test-secret", 1_000_000, 1700000000);
    expect(verified.valid).toBe(true);
  });

  it("throws SubscriberDeliveryError on non-2xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("boom"),
    });
    await expect(
      deliverToSubscriber(sub, { RecordType: "Inbound", MessageID: "m" }, "m")
    ).rejects.toBeInstanceOf(SubscriberDeliveryError);
  });

  it("throws SubscriberDeliveryError on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      deliverToSubscriber(sub, { RecordType: "Inbound", MessageID: "m" }, "m")
    ).rejects.toMatchObject({ subscription: "jqs", status: undefined });
  });
});

describe("dispatchInbound", () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const subs: ResolvedSubscription[] = [
    {
      name: "jqs",
      filter: { aliasPattern: "*@inbox.example.com" },
      endpoint_url: "https://jq.example/inbound",
      hmac_secret: "jq-secret",
    },
    {
      name: "other",
      filter: { aliasPattern: "*@notify.example.com" },
      endpoint_url: "https://other.example/inbound",
      hmac_secret: "other-secret",
    },
  ];

  const inboundPayload = {
    RecordType: "Inbound",
    MessageID: "pm-1",
    To: "haro@inbox.example.com",
    ToFull: [{ Email: "haro@inbox.example.com" }],
  };

  it("noop when not inbound payload", async () => {
    await dispatchInbound({ RecordType: "Delivery" }, subs);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("noop when no subscription matches", async () => {
    await dispatchInbound(
      { ...inboundPayload, To: "stranger@unknown.com", ToFull: [{ Email: "stranger@unknown.com" }] },
      subs
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fans out to single matching subscription on success", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve("ok") });
    await dispatchInbound(inboundPayload, subs);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("https://jq.example/inbound");
  });

  it("throws when a subscriber fails (fail loud)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("oops"),
    });
    await expect(dispatchInbound(inboundPayload, subs)).rejects.toBeInstanceOf(
      SubscriberDeliveryError
    );
  });

  it("throws when MessageID missing on inbound payload", async () => {
    await expect(
      dispatchInbound({ RecordType: "Inbound", To: "haro@inbox.example.com" }, subs)
    ).rejects.toThrow(/MessageID/);
  });
});
