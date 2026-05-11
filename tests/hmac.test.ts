import { describe, it, expect } from "vitest";
import { signRequest, verifyRequest } from "../src/lib/hmac";

describe("hmac", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ hello: "world" });

  it("verifies a fresh signature", () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = signRequest(body, secret, t);
    expect(verifyRequest(sig, body, secret, 300, t).valid).toBe(true);
  });

  it("rejects missing header", () => {
    const res = verifyRequest(undefined, body, secret);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("missing_header");
  });

  it("rejects malformed header", () => {
    expect(verifyRequest("garbage", body, secret).reason).toBe("malformed_header");
    expect(verifyRequest("t=abc,v1=", body, secret).reason).toBe("malformed_header");
    expect(verifyRequest("t=123", body, secret).reason).toBe("malformed_header");
  });

  it("rejects stale timestamp", () => {
    const t = 1_700_000_000;
    const sig = signRequest(body, secret, t);
    const res = verifyRequest(sig, body, secret, 300, t + 1000);
    expect(res.reason).toBe("stale_timestamp");
  });

  it("rejects tampered body", () => {
    const t = 1_700_000_000;
    const sig = signRequest(body, secret, t);
    const res = verifyRequest(sig, body + "tamper", secret, 300, t);
    expect(res.reason).toBe("signature_mismatch");
  });

  it("rejects wrong secret", () => {
    const t = 1_700_000_000;
    const sig = signRequest(body, secret, t);
    const res = verifyRequest(sig, body, "wrong-secret", 300, t);
    expect(res.reason).toBe("signature_mismatch");
  });

  it("uses timing-safe comparison (different length v1)", () => {
    const t = 1_700_000_000;
    const sig = `t=${t},v1=deadbeef`;
    const res = verifyRequest(sig, body, secret, 300, t);
    expect(res.reason).toBe("signature_mismatch");
  });
});
