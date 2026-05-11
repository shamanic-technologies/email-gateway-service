import { createHmac, timingSafeEqual } from "crypto";

const SIGNATURE_HEADER = "x-eg-signature";
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignedHeaders {
  [SIGNATURE_HEADER]: string;
}

export function signRequest(body: string, secret: string, nowSeconds?: number): string {
  const t = nowSeconds ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export interface VerifyResult {
  valid: boolean;
  reason?: "missing_header" | "malformed_header" | "stale_timestamp" | "signature_mismatch";
}

export function verifyRequest(
  headerValue: string | undefined,
  body: string,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds?: number
): VerifyResult {
  if (!headerValue) return { valid: false, reason: "missing_header" };

  const parts = headerValue.split(",").map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));
  if (!tPart || !v1Part) return { valid: false, reason: "malformed_header" };

  const t = Number(tPart.slice(2));
  const v1 = v1Part.slice(3);
  if (!Number.isFinite(t) || v1.length === 0) return { valid: false, reason: "malformed_header" };

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) {
    return { valid: false, reason: "stale_timestamp" };
  }

  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(v1, "hex");
  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: "signature_mismatch" };
  }
  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}

export { SIGNATURE_HEADER };
