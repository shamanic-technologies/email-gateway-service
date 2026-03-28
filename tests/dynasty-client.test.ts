import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSlugToDynastyMap } from "../src/lib/dynasty-client";

vi.mock("../src/config", () => ({
  config: {
    port: 3009,
    apiKey: "test-api-key",
    postmark: { url: "http://localhost:3010", apiKey: "pm-key" },
    instantly: { url: "http://localhost:3011", apiKey: "inst-key" },
    brand: { url: "http://localhost:3005", apiKey: "brand-key" },
    key: { url: "", apiKey: "" },
    features: { url: "http://features:3020", apiKey: "feat-key" },
    workflow: { url: "http://workflow:3021", apiKey: "wf-key" },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("dynasty-client", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("resolveWorkflowDynastySlugs", () => {
    it("calls workflow-service and returns slugs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ slugs: ["cold-email", "cold-email-v2", "cold-email-v3"] }),
      });

      // Re-import to get fresh module with mocked config
      const { resolveWorkflowDynastySlugs } = await import("../src/lib/dynasty-client");
      const slugs = await resolveWorkflowDynastySlugs("cold-email");

      expect(slugs).toEqual(["cold-email", "cold-email-v2", "cold-email-v3"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/workflows/dynasty/slugs?dynastySlug=cold-email");
      expect(opts.headers["X-API-Key"]).toBe("wf-key");
    });

    it("returns empty array when dynasty has no slugs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ slugs: [] }),
      });

      const { resolveWorkflowDynastySlugs } = await import("../src/lib/dynasty-client");
      const slugs = await resolveWorkflowDynastySlugs("nonexistent");

      expect(slugs).toEqual([]);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not found"),
      });

      const { resolveWorkflowDynastySlugs } = await import("../src/lib/dynasty-client");
      await expect(resolveWorkflowDynastySlugs("bad")).rejects.toThrow("dynasty-client");
    });
  });

  describe("resolveFeatureDynastySlugs", () => {
    it("calls features-service and returns slugs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ slugs: ["feat-alpha", "feat-alpha-v2"] }),
      });

      const { resolveFeatureDynastySlugs } = await import("../src/lib/dynasty-client");
      const slugs = await resolveFeatureDynastySlugs("feat-alpha");

      expect(slugs).toEqual(["feat-alpha", "feat-alpha-v2"]);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/features/dynasty/slugs?dynastySlug=feat-alpha");
      expect(opts.headers["X-API-Key"]).toBe("feat-key");
    });
  });

  describe("fetchWorkflowDynasties", () => {
    it("returns all workflow dynasties", async () => {
      const dynasties = [
        { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
        { dynastySlug: "warm-intro", slugs: ["warm-intro"] },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dynasties }),
      });

      const { fetchWorkflowDynasties } = await import("../src/lib/dynasty-client");
      const result = await fetchWorkflowDynasties();

      expect(result).toEqual(dynasties);
      expect(mockFetch.mock.calls[0][0]).toContain("/workflows/dynasties");
    });
  });

  describe("fetchFeatureDynasties", () => {
    it("returns all feature dynasties", async () => {
      const dynasties = [
        { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dynasties }),
      });

      const { fetchFeatureDynasties } = await import("../src/lib/dynasty-client");
      const result = await fetchFeatureDynasties();

      expect(result).toEqual(dynasties);
      expect(mockFetch.mock.calls[0][0]).toContain("/features/dynasties");
    });
  });

  describe("buildSlugToDynastyMap", () => {
    it("builds reverse map from dynasties", () => {
      const dynasties = [
        { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2", "cold-email-v3"] },
        { dynastySlug: "warm-intro", slugs: ["warm-intro", "warm-intro-v2"] },
      ];

      const map = buildSlugToDynastyMap(dynasties);

      expect(map.get("cold-email")).toBe("cold-email");
      expect(map.get("cold-email-v2")).toBe("cold-email");
      expect(map.get("cold-email-v3")).toBe("cold-email");
      expect(map.get("warm-intro")).toBe("warm-intro");
      expect(map.get("warm-intro-v2")).toBe("warm-intro");
      expect(map.get("unknown")).toBeUndefined();
    });

    it("returns empty map for empty input", () => {
      const map = buildSlugToDynastyMap([]);
      expect(map.size).toBe(0);
    });
  });
});
