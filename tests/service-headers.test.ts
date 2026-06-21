import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { extractOrgContext } from "../src/middleware/requireOrgId";
import { buildServiceHeaders } from "../src/lib/service-headers";

function reqWith(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

describe("x-audience-id tracking propagation", () => {
  it("reads x-audience-id inbound and forwards it on internal egress", () => {
    const ctx = extractOrgContext(
      reqWith({
        "x-org-id": "org_1",
        "x-run-id": "run_1",
        "x-audience-id": "aud_123",
      }),
    );
    expect(ctx?.audienceId).toBe("aud_123");

    const egress = buildServiceHeaders("apikey", ctx ?? undefined);
    expect(egress["x-audience-id"]).toBe("aud_123");
  });

  it("omits x-audience-id when absent (no throw, optional outside campaign flow)", () => {
    const ctx = extractOrgContext(reqWith({ "x-org-id": "org_1" }));
    expect(ctx?.audienceId).toBeUndefined();

    const egress = buildServiceHeaders("apikey", ctx ?? undefined);
    expect("x-audience-id" in egress).toBe(false);
  });
});
