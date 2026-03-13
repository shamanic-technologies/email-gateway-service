import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerProviderRequirements } from "../src/lib/register-providers";

vi.mock("../src/config", () => ({
  config: {
    port: 3009,
    apiKey: "test-api-key",
    postmark: { url: "http://localhost:3010", apiKey: "pm-key" },
    instantly: { url: "http://localhost:3011", apiKey: "inst-key" },
    brand: { url: "http://localhost:3005", apiKey: "brand-key" },
    key: { url: "http://localhost:3001", apiKey: "key-svc-key" },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("registerProviderRequirements", () => {
  it("queries downstream requirements and registers each provider", async () => {
    // Step 1: POST /provider-requirements returns instantly + postmark
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          requirements: [
            { service: "instantly", method: "POST", path: "/send", provider: "instantly" },
            { service: "postmark", method: "POST", path: "/send", provider: "postmark" },
          ],
          providers: ["instantly", "postmark"],
        }),
    });

    // Step 2: decrypt calls (one per provider) — 404 is expected
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve("Not found") });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve("Not found") });

    await registerProviderRequirements();

    // Verify provider-requirements query
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [reqUrl, reqInit] = mockFetch.mock.calls[0];
    expect(reqUrl).toBe("http://localhost:3001/provider-requirements");
    expect(reqInit.method).toBe("POST");
    expect(JSON.parse(reqInit.body)).toEqual({
      endpoints: [
        { service: "instantly", method: "POST", path: "/send" },
        { service: "postmark", method: "POST", path: "/send" },
      ],
    });
    expect(reqInit.headers["x-api-key"]).toBe("key-svc-key");

    // Verify decrypt calls include X-Caller-* headers for email-gateway
    const decryptCalls = mockFetch.mock.calls.slice(1);
    const decryptUrls = decryptCalls.map(([url]: [string]) => url).sort();
    expect(decryptUrls).toEqual([
      "http://localhost:3001/keys/platform/instantly/decrypt",
      "http://localhost:3001/keys/platform/postmark/decrypt",
    ]);

    for (const [, init] of decryptCalls) {
      expect(init.headers["x-caller-service"]).toBe("email-gateway");
      expect(init.headers["x-caller-method"]).toBe("POST");
      expect(init.headers["x-caller-path"]).toBe("/send");
      expect(init.headers["x-api-key"]).toBe("key-svc-key");
    }
  });

  it("deduplicates providers across downstream endpoints", async () => {
    // Both downstream endpoints return the same provider
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          requirements: [
            { service: "instantly", method: "POST", path: "/send", provider: "shared-provider" },
            { service: "postmark", method: "POST", path: "/send", provider: "shared-provider" },
          ],
          providers: ["shared-provider"],
        }),
    });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve("") });

    await registerProviderRequirements();

    // Only one decrypt call (deduplicated)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe(
      "http://localhost:3001/keys/platform/shared-provider/decrypt"
    );
  });

  it("handles provider-requirements query failure gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal error"),
    });

    await registerProviderRequirements();

    // Should not attempt decrypt calls
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to query provider requirements")
    );
  });

  it("handles empty requirements gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ requirements: [], providers: [] }),
    });

    await registerProviderRequirements();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("No downstream provider requirements found")
    );
  });

  it("continues registration when one decrypt call fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          requirements: [
            { service: "instantly", method: "POST", path: "/send", provider: "instantly" },
            { service: "postmark", method: "POST", path: "/send", provider: "postmark" },
          ],
          providers: ["instantly", "postmark"],
        }),
    });

    // First decrypt fails with network error, second succeeds (404)
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve("") });

    await registerProviderRequirements();

    // Both calls attempted despite first failure
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Registered provider requirements")
    );
  });

  it("skips registration when key-service config is missing", async () => {
    // Temporarily override config
    const { config } = await import("../src/config");
    const origUrl = config.key.url;
    const origKey = config.key.apiKey;
    Object.defineProperty(config.key, "url", { value: "", writable: true, configurable: true });

    await registerProviderRequirements();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping provider registration")
    );

    // Restore
    Object.defineProperty(config.key, "url", { value: origUrl, writable: true, configurable: true });
    Object.defineProperty(config.key, "apiKey", { value: origKey, writable: true, configurable: true });
  });

  it("logs warning for non-404 decrypt failures", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          requirements: [
            { service: "instantly", method: "POST", path: "/send", provider: "instantly" },
          ],
          providers: ["instantly"],
        }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server error"),
    });

    await registerProviderRequirements();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Provider registration warning for instantly: 500")
    );
  });
});
