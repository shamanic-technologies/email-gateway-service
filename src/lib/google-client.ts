import { config } from "../config";
import { buildServiceHeaders } from "./service-headers";
import type { OrgContext } from "../middleware/requireOrgId";

// google-service: the org's connected Google mailboxes (RIGHT-MOMENT-OR-LATER-1014).
// Two calls only: which Gmail thread holds the person's latest exchange, and a
// reply in it. Each call carries the request's identity headers (google-service
// requires x-org-id, x-user-id, x-run-id).

const TIMEOUT_MS = 10_000;
// A reply makes ~4 sequential Google calls (token, send-as, send, re-read).
const SEND_TIMEOUT_MS = 60_000;

export class GoogleHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(message);
    this.name = "GoogleHttpError";
  }
}

export interface LatestGmailThread {
  threadId: string;
  googleAccountId: string;
  mailbox: string;
  fromAddress: string;
  lastMessageAt: string | null;
  lastMessageDirection: "inbound" | "outbound" | "other";
  subject: string | null;
  sendPermission: boolean;
}

export type LatestGmailThreadResult =
  | { found: true; thread: LatestGmailThread }
  | { found: false; reason: string };

function baseUrl(): string {
  const { url, apiKey } = config.google;
  if (!url || !apiKey) {
    throw new Error("google-service is not configured (GOOGLE_SERVICE_URL / GOOGLE_SERVICE_API_KEY)");
  }
  return url;
}

async function call(path: string, init: { method: string; body?: unknown; ctx: OrgContext; timeoutMs: number }) {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    method: init.method,
    headers: buildServiceHeaders(config.google.apiKey, init.ctx),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GoogleHttpError(`google-service ${init.method} ${path}: ${res.status} - ${text}`, res.status, text);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * The person's latest Gmail thread in the org's mirror. Its two documented
 * 404s (no mailbox connected, no answerable thread) are an answer, `found:
 * false`; anything else is an error (the caller cannot know where the person
 * last wrote, so it does not guess).
 */
export async function getLatestGmailThread(email: string, ctx: OrgContext): Promise<LatestGmailThreadResult> {
  try {
    const body = (await call(`/orgs/google/threads/latest?email=${encodeURIComponent(email)}`, {
      method: "GET",
      ctx,
      timeoutMs: TIMEOUT_MS,
    })) as { thread: LatestGmailThread };
    return { found: true, thread: body.thread };
  } catch (error) {
    if (error instanceof GoogleHttpError && error.status === 404) {
      try {
        const parsed = JSON.parse(error.bodyText) as { reason?: unknown };
        if (parsed.reason === "no_google_account_connected" || parsed.reason === "no_messages") {
          return { found: false, reason: parsed.reason };
        }
      } catch {
        // not a documented answer: failed below
      }
    }
    // A READ failure is never a refusal about the person: plain error -> 502.
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

export interface GmailThreadReply {
  sent: true;
  gmailMessageId: string;
  threadId: string;
  mailbox: string;
  from: string;
  to: string;
  subject: string;
}

/** One reply in the thread. Not retried: a retry of a send that went through mails twice. */
export async function replyInGmailThread(
  body: { to: string; threadId: string; bodyHtml: string; bodyText?: string },
  ctx: OrgContext,
): Promise<GmailThreadReply> {
  return (await call("/orgs/google/thread-replies", {
    method: "POST",
    body,
    ctx,
    timeoutMs: SEND_TIMEOUT_MS,
  })) as GmailThreadReply;
}
