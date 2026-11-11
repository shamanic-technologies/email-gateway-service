/**
 * The one fetch every SEND goes through (postmark, instantly, google).
 *
 * A send is not idempotent: once the request reached the sender, the email may
 * be out even if we never read the answer. So:
 *   - a failure that PROVES the request never left (connection refused, DNS)
 *     is retried once after 500 ms, and if it fails again the email was not
 *     sent (plain error -> 502);
 *   - any other failure (our timeout, a reset socket, a closed connection) is
 *     a SendOutcomeUnknownError: never retried, answered 504
 *     `send_outcome_unknown` so the caller can tell it from "not sent".
 *
 * Why: the postmark client re-sent POST /orgs/send after its own 10 s timeout
 * while postmark-service had already submitted to Postmark ~2 s in. 598
 * newsletter subscribers got the same issue twice in 14 days, and a new
 * client got two welcome emails while the caller was told 502 (SIGNUP-EMAILS-1111).
 */

export const SEND_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 500;

/** Error codes that mean the request never reached the upstream. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export class SendOutcomeUnknownError extends Error {
  readonly code = "send_outcome_unknown";
  constructor(message: string) {
    super(message);
    this.name = "SendOutcomeUnknownError";
  }
}

/** undici wraps the socket error: `TypeError: fetch failed` with `cause.code`. */
export function neverReachedUpstream(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; depth < 4 && e && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export async function sendFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  label: string,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!neverReachedUpstream(error)) {
        throw new SendOutcomeUnknownError(
          `${label}: outcome unknown, the email may have been sent (${message}); not retried`,
        );
      }
      if (attempt >= 1) throw new Error(`${label}: ${message} (not sent: upstream unreachable)`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}
