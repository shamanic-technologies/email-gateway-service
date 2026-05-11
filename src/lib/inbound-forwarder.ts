import { z } from "zod";
import { signRequest, SIGNATURE_HEADER } from "./hmac";

export const SubscriptionFilterSchema = z.object({
  aliasPattern: z.string().min(1).describe("Alias pattern, e.g. '*@inbox.example.com' (wildcard) or 'haro@inbox.example.com' (exact)"),
});

export const SubscriptionSchema = z.object({
  name: z.string().min(1).describe("Logical subscription name, used in logs and error messages"),
  filter: SubscriptionFilterSchema,
  endpoint_url: z.string().url().describe("HTTPS URL the inbound payload is POSTed to"),
  hmac_secret_env: z.string().min(1).describe("Name of the process.env var holding the HMAC shared secret for this subscription"),
});

export const SubscriptionsSchema = z.array(SubscriptionSchema);

export type Subscription = z.infer<typeof SubscriptionSchema>;

export interface ResolvedSubscription {
  name: string;
  filter: { aliasPattern: string };
  endpoint_url: string;
  hmac_secret: string;
}

export function parseSubscriptions(raw: string | undefined): Subscription[] {
  if (!raw) return [];
  const json = JSON.parse(raw);
  return SubscriptionsSchema.parse(json);
}

export function resolveSubscriptions(subs: Subscription[]): ResolvedSubscription[] {
  return subs.map((s) => {
    const secret = process.env[s.hmac_secret_env];
    if (!secret || secret.length === 0) {
      throw new Error(
        `subscription "${s.name}" references hmac_secret_env="${s.hmac_secret_env}" but that env var is not set or empty`
      );
    }
    return {
      name: s.name,
      filter: s.filter,
      endpoint_url: s.endpoint_url,
      hmac_secret: secret,
    };
  });
}

export function matchAlias(pattern: string, email: string): boolean {
  const normalizedEmail = email.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  if (normalizedPattern.startsWith("*@")) {
    const domain = normalizedPattern.slice(2);
    const atIndex = normalizedEmail.indexOf("@");
    if (atIndex <= 0) return false;
    return normalizedEmail.slice(atIndex + 1) === domain;
  }

  return normalizedEmail === normalizedPattern;
}

export function findMatchingSubscriptions(
  subs: ResolvedSubscription[],
  recipients: string[]
): ResolvedSubscription[] {
  const matched = new Set<ResolvedSubscription>();
  for (const sub of subs) {
    for (const recipient of recipients) {
      if (matchAlias(sub.filter.aliasPattern, recipient)) {
        matched.add(sub);
        break;
      }
    }
  }
  return [...matched];
}

interface InboundLikePayload {
  RecordType?: unknown;
  MessageID?: unknown;
  To?: unknown;
  ToFull?: unknown;
}

export function isInboundPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as InboundLikePayload).RecordType === "Inbound";
}

export function extractInboundRecipients(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as InboundLikePayload;
  const set = new Set<string>();

  if (typeof p.To === "string" && p.To.length > 0) {
    set.add(p.To);
  }
  if (Array.isArray(p.ToFull)) {
    for (const entry of p.ToFull) {
      if (entry && typeof entry === "object" && typeof (entry as { Email?: unknown }).Email === "string") {
        set.add((entry as { Email: string }).Email);
      }
    }
  }
  return [...set];
}

export function extractMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as InboundLikePayload).MessageID;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export class SubscriberDeliveryError extends Error {
  readonly subscription: string;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(subscription: string, message: string, status: number | undefined, cause?: unknown) {
    super(message);
    this.name = "SubscriberDeliveryError";
    this.subscription = subscription;
    this.status = status;
    this.cause = cause;
  }
}

export async function deliverToSubscriber(
  sub: ResolvedSubscription,
  payload: unknown,
  messageId: string,
  nowSeconds?: number
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = signRequest(body, sub.hmac_secret, nowSeconds);

  let response: Response;
  try {
    response = await fetch(sub.endpoint_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature,
        "idempotency-key": messageId,
      },
      body,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown network error";
    throw new SubscriberDeliveryError(sub.name, `network error: ${msg}`, undefined, err);
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      // ignore body-read errors; status alone is enough to fail loud
    }
    throw new SubscriberDeliveryError(
      sub.name,
      `HTTP ${response.status} ${text.slice(0, 200)}`,
      response.status
    );
  }
}

/**
 * Fan out an inbound payload to every matching subscription.
 * Throws on the first subscriber failure so callers return 5xx and Postmark retries.
 * Skips silently when payload is not inbound, has no MessageID, or no subscription matches.
 */
export async function dispatchInbound(
  payload: unknown,
  subscriptions: ResolvedSubscription[]
): Promise<void> {
  if (!isInboundPayload(payload)) return;

  const messageId = extractMessageId(payload);
  if (!messageId) {
    throw new Error("inbound payload missing MessageID");
  }

  const recipients = extractInboundRecipients(payload);
  if (recipients.length === 0) return;

  const matched = findMatchingSubscriptions(subscriptions, recipients);
  if (matched.length === 0) return;

  for (const sub of matched) {
    await deliverToSubscriber(sub, payload, messageId);
  }
}
