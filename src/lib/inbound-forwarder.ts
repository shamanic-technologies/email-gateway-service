import { z } from "zod";
import * as inboundDedup from "./inbound-dedup";

export const ForwardingRuleSchema = z.object({
  aliasPattern: z.string().min(1).describe("Alias pattern, e.g. '*@inbox.example.com' (wildcard) or 'haro@inbox.example.com' (exact)"),
  consumerUrl: z.string().url().describe("HTTPS URL the inbound payload is POSTed to"),
  consumerName: z.string().min(1).describe("Logical consumer name, used in logs"),
  consumerApiKey: z.string().min(1).describe("Shared service key sent as x-api-key to the consumer"),
});

export const ForwardingRulesSchema = z.array(ForwardingRuleSchema);

export type ForwardingRule = z.infer<typeof ForwardingRuleSchema>;

export function parseRules(raw: string | undefined): ForwardingRule[] {
  if (!raw) return [];
  const json = JSON.parse(raw);
  return ForwardingRulesSchema.parse(json);
}

export function matchAlias(pattern: string, email: string): boolean {
  const normalizedEmail = email.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  if (normalizedPattern.startsWith("*@")) {
    const domain = normalizedPattern.slice(2);
    const atIndex = normalizedEmail.indexOf("@");
    if (atIndex <= 0) return false; // require at least 1 char before @
    return normalizedEmail.slice(atIndex + 1) === domain;
  }

  return normalizedEmail === normalizedPattern;
}

export function findMatchingRules(
  rules: ForwardingRule[],
  recipients: string[]
): ForwardingRule[] {
  const matched = new Set<ForwardingRule>();
  for (const rule of rules) {
    for (const recipient of recipients) {
      if (matchAlias(rule.aliasPattern, recipient)) {
        matched.add(rule);
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
  const p = payload as InboundLikePayload;
  return p.RecordType === "Inbound";
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

/**
 * Fire-and-forget per-rule POST. Errors are caught and logged, never propagated.
 * Caller should `await` the returned promise to ensure tests see the side effects;
 * production callers may also await but the response to Postmark must not depend on it.
 */
export async function forwardToConsumer(
  rule: ForwardingRule,
  payload: unknown,
  messageId: string
): Promise<void> {
  try {
    const response = await fetch(rule.consumerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": rule.consumerApiKey,
        "x-service-name": "email-gateway-service",
        "x-postmark-message-id": messageId,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        `[email-gateway] inbound-forward failed consumer=${rule.consumerName} messageId=${messageId} error=HTTP ${response.status} ${text}`
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[email-gateway] inbound-forward failed consumer=${rule.consumerName} messageId=${messageId} error=${msg}`
    );
  }
}

/**
 * Evaluate inbound forwarding rules against a Postmark inbound webhook payload
 * and POST to each matching consumer. Idempotent on payload.MessageID.
 *
 * Skips silently if:
 *   - payload is not an inbound webhook
 *   - no MessageID is present
 *   - MessageID has been seen before (dedup hit)
 *   - no rules match the payload's recipients
 */
export async function dispatchInbound(
  payload: unknown,
  rules: ForwardingRule[]
): Promise<void> {
  if (!isInboundPayload(payload)) return;

  const messageId = extractMessageId(payload);
  if (!messageId) return;

  if (inboundDedup.seen(messageId)) {
    console.log(`[email-gateway] inbound-forward dedup messageId=${messageId}`);
    return;
  }

  const recipients = extractInboundRecipients(payload);
  if (recipients.length === 0) return;

  const matched = findMatchingRules(rules, recipients);
  if (matched.length === 0) return;

  await Promise.all(matched.map((rule) => forwardToConsumer(rule, payload, messageId)));
}
