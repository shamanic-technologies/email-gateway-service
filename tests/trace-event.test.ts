import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrgContext } from "../src/middleware/requireOrgId";

// Mock config — must come before importing traceEvent
vi.mock("../src/config", () => ({
  config: {
    port: 3009,
    apiKey: "test-api-key",
    postmark: { url: "http://localhost:3010", apiKey: "pm-key" },
    instantly: { url: "http://localhost:3011", apiKey: "inst-key" },
    brand: { url: "http://localhost:3005", apiKey: "brand-key" },
    key: { url: "", apiKey: "" },
    runs: { url: "https://runs.test", apiKey: "runs-key" },
  },
}));

import { traceEvent } from "../src/lib/trace-event";

const mockFetch = vi.fn();
const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true });
  global.fetch = mockFetch;
  consoleSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fullCtx: OrgContext = {
  orgId: "org_123",
  userId: "user_456",
  runId: "run_789",
  brandId: "brand_abc",
  campaignId: "camp_def",
  workflowSlug: "onboarding-v2",
  featureSlug: "welcome-email",
  goal: "signup",
  brandProfileId: "brand_profile_123",
  customerPersonaId: "persona_abc",
  customerProfileId: "profile_def",
};

describe("traceEvent", () => {
  it("POSTs to correct URL with event/detail payload", () => {
    traceEvent(fullCtx, "email.sent", "Sent transactional email to user@example.com");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://runs.test/v1/runs/run_789/events");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      event: "email.sent",
      detail: "Sent transactional email to user@example.com",
    });
  });

  it("forwards identity and attribution headers from OrgContext", () => {
    traceEvent(fullCtx, "email.sent", "detail");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("org_123");
    expect(opts.headers["x-user-id"]).toBe("user_456");
    expect(opts.headers["x-brand-id"]).toBe("brand_abc");
    expect(opts.headers["x-campaign-id"]).toBe("camp_def");
    expect(opts.headers["x-workflow-slug"]).toBe("onboarding-v2");
    expect(opts.headers["x-feature-slug"]).toBe("welcome-email");
    expect(opts.headers["x-goal"]).toBe("signup");
    expect(opts.headers["x-brand-profile-id"]).toBe("brand_profile_123");
    expect(opts.headers["x-customer-persona-id"]).toBe("persona_abc");
    expect(opts.headers["x-customer-profile-id"]).toBe("profile_def");
  });

  it("sends API key as X-API-Key header", () => {
    traceEvent(fullCtx, "email.sent", "detail");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["X-API-Key"]).toBe("runs-key");
  });

  it("skips POST when runId is missing", () => {
    const ctxNoRun: OrgContext = { orgId: "org_123" };
    traceEvent(ctxNoRun, "email.sent", "detail");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips POST when ctx is undefined", () => {
    traceEvent(undefined, "email.sent", "detail");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("logs error on fetch failure but does not throw", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error("network down"));

    traceEvent(fullCtx, "email.sent", "detail");

    // Wait for the microtask (.catch handler) to execute
    await new Promise((r) => setTimeout(r, 10));

    expect(errorSpy).toHaveBeenCalledWith(
      "[email-gateway] traceEvent failed: network down"
    );
    errorSpy.mockRestore();
  });

  it("returns void (fire-and-forget)", () => {
    const result = traceEvent(fullCtx, "email.sent", "detail");
    expect(result).toBeUndefined();
  });

  it("omits optional headers when context fields are missing", () => {
    const minimalCtx: OrgContext = { orgId: "org_123", runId: "run_1" };
    traceEvent(minimalCtx, "email.sent", "detail");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("org_123");
    expect(opts.headers).not.toHaveProperty("x-user-id");
    expect(opts.headers).not.toHaveProperty("x-brand-id");
    expect(opts.headers).not.toHaveProperty("x-campaign-id");
    expect(opts.headers).not.toHaveProperty("x-workflow-slug");
    expect(opts.headers).not.toHaveProperty("x-feature-slug");
  });
});
