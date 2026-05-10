import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  matchAlias,
  findMatchingRules,
  parseRules,
  extractInboundRecipients,
  type ForwardingRule,
} from "../src/lib/inbound-forwarder";
import * as inboundDedup from "../src/lib/inbound-dedup";

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
    expect(matchAlias("haro@inbox.example.com", "HARO@INBOX.EXAMPLE.COM")).toBe(true);
  });

  it("exact pattern does not match different local-part", () => {
    expect(matchAlias("haro@inbox.example.com", "qwoted@inbox.example.com")).toBe(false);
  });

  it("wildcard matches empty local-part edge case is not allowed (must have something before @)", () => {
    expect(matchAlias("*@inbox.example.com", "@inbox.example.com")).toBe(false);
  });
});

describe("findMatchingRules", () => {
  const rules: ForwardingRule[] = [
    {
      aliasPattern: "*@inbox.example.com",
      consumerUrl: "https://jq/webhook",
      consumerName: "journalists-quotes-service",
      consumerApiKey: "jq-key",
    },
    {
      aliasPattern: "noreply@notifications.example.com",
      consumerUrl: "https://other/webhook",
      consumerName: "other",
      consumerApiKey: "other-key",
    },
  ];

  it("returns matching rule for wildcard", () => {
    const matched = findMatchingRules(rules, ["haro@inbox.example.com"]);
    expect(matched).toHaveLength(1);
    expect(matched[0].consumerName).toBe("journalists-quotes-service");
  });

  it("returns empty array for no match", () => {
    const matched = findMatchingRules(rules, ["random@unknown.com"]);
    expect(matched).toEqual([]);
  });

  it("returns multiple rules when multiple match different recipients", () => {
    const matched = findMatchingRules(rules, [
      "haro@inbox.example.com",
      "noreply@notifications.example.com",
    ]);
    expect(matched).toHaveLength(2);
  });

  it("deduplicates rule when multiple recipients match the same rule", () => {
    const matched = findMatchingRules(rules, [
      "haro@inbox.example.com",
      "qwoted@inbox.example.com",
    ]);
    expect(matched).toHaveLength(1);
  });
});

describe("parseRules", () => {
  it("parses valid JSON rules", () => {
    const json = JSON.stringify([
      {
        aliasPattern: "*@inbox.example.com",
        consumerUrl: "https://jq/webhook",
        consumerName: "journalists-quotes-service",
        consumerApiKey: "jq-key",
      },
    ]);
    const rules = parseRules(json);
    expect(rules).toHaveLength(1);
    expect(rules[0].aliasPattern).toBe("*@inbox.example.com");
  });

  it("returns empty list when env var unset (undefined)", () => {
    expect(parseRules(undefined)).toEqual([]);
  });

  it("returns empty list when env var is empty string", () => {
    expect(parseRules("")).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseRules("{not json")).toThrow();
  });

  it("throws on missing required field consumerUrl", () => {
    const bad = JSON.stringify([{ aliasPattern: "*@x.com", consumerName: "x", consumerApiKey: "k" }]);
    expect(() => parseRules(bad)).toThrow();
  });

  it("throws when shape is not array", () => {
    const bad = JSON.stringify({ aliasPattern: "*@x.com", consumerUrl: "u", consumerName: "n", consumerApiKey: "k" });
    expect(() => parseRules(bad)).toThrow();
  });
});

describe("extractInboundRecipients", () => {
  it("returns To field as single recipient when present", () => {
    expect(extractInboundRecipients({ To: "haro@inbox.example.com" })).toEqual([
      "haro@inbox.example.com",
    ]);
  });

  it("returns ToFull[].Email when present", () => {
    const recipients = extractInboundRecipients({
      ToFull: [
        { Email: "haro@inbox.example.com", Name: "HARO", MailboxHash: "" },
        { Email: "qwoted@inbox.example.com", Name: "Qwoted", MailboxHash: "" },
      ],
    });
    expect(recipients).toEqual(["haro@inbox.example.com", "qwoted@inbox.example.com"]);
  });

  it("merges To and ToFull (deduplicated)", () => {
    const recipients = extractInboundRecipients({
      To: "haro@inbox.example.com",
      ToFull: [{ Email: "haro@inbox.example.com" }, { Email: "other@x.com" }],
    });
    expect(recipients.sort()).toEqual(["haro@inbox.example.com", "other@x.com"].sort());
  });

  it("returns empty array when neither present", () => {
    expect(extractInboundRecipients({})).toEqual([]);
  });
});

describe("inboundDedup", () => {
  beforeEach(() => {
    inboundDedup.clear();
  });

  it("first MessageID is not dedup", () => {
    expect(inboundDedup.seen("msg-1")).toBe(false);
  });

  it("second MessageID is dedup", () => {
    inboundDedup.seen("msg-1");
    expect(inboundDedup.seen("msg-1")).toBe(true);
  });

  it("different MessageIDs are independent", () => {
    expect(inboundDedup.seen("msg-1")).toBe(false);
    expect(inboundDedup.seen("msg-2")).toBe(false);
  });

  it("respects bounded size by evicting oldest", () => {
    const max = inboundDedup.MAX_ENTRIES;
    for (let i = 0; i < max; i++) inboundDedup.seen(`msg-${i}`);
    inboundDedup.seen("overflow");
    // Oldest should be evicted: msg-0 should now be re-eligible
    expect(inboundDedup.seen("msg-0")).toBe(false);
  });

  it("expires entries after TTL", () => {
    vi.useFakeTimers();
    inboundDedup.seen("msg-ttl");
    expect(inboundDedup.seen("msg-ttl")).toBe(true);
    vi.advanceTimersByTime(inboundDedup.TTL_MS + 1);
    expect(inboundDedup.seen("msg-ttl")).toBe(false);
    vi.useRealTimers();
  });
});
