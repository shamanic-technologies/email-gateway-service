import { config } from "../config";
import { buildServiceHeaders } from "./service-headers";
import type { OrgContext } from "../middleware/requireOrgId";
import type {
  StatusScope,
  GlobalStatus,
  RecipientStats,
  EmailStats,
} from "@shamanic-technologies/email-domain-contract";

const { url, apiKey } = config.postmark;

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 500;

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; ctx?: OrgContext } = {}
): Promise<T> {
  const { method = "GET", body, ctx } = options;
  const fullUrl = `${url}${path}`;
  const headers = buildServiceHeaders(apiKey, ctx);
  const jsonBody = body ? JSON.stringify(body) : undefined;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(fullUrl, {
        method,
        headers,
        body: jsonBody,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `postmark-service ${method} ${path}: ${response.status} - ${errorText}`
        );
      }

      return response.json() as Promise<T>;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Only retry on network-level errors (fetch failed, timeout), not HTTP errors
      if (lastError.message.includes("postmark-service")) throw lastError;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(
    `postmark-service ${method} ${path}: ${lastError?.message ?? "fetch failed"} (url: ${url})`
  );
}

export async function sendEmail(body: {
  orgId?: string;
  userId?: string;
  runId?: string;
  leadId?: string;
  workflowSlug?: string;
  campaignId?: string;
  from?: string;
  to: string;
  bcc?: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  replyTo?: string;
  tag?: string;
  metadata?: Record<string, string>;
  inReplyTo?: string;
  references?: string;
  messageStream?: string;
}, ctx?: OrgContext) {
  return request<{
    success: boolean;
    messageId?: string;
    submittedAt?: string;
    sendingId?: string;
    errorCode?: number;
    message?: string;
  }>("/orgs/send", { method: "POST", body, ctx });
}

// Re-export shared provider types from instantly-client
import type { ProviderStatsResult } from "./instantly-client";

function buildStatsQuery(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function getStats(filters: {
  runIds?: string[];
  orgId?: string;
  userId?: string;
  brandId?: string;
  campaignId?: string;
  workflowSlugs?: string;
  featureSlugs?: string;
  groupBy?: string;
}, ctx?: OrgContext) {
  const basePath = ctx?.orgId ? "/orgs/stats" : "/internal/stats";
  const path = basePath + buildStatsQuery(filters);
  return request<ProviderStatsResult>(path, { ctx });
}

/**
 * postmark-service's per-operation read (v0.33.0+).
 *
 * The operation is named by the CALLER'S OWN RUN, which postmark-service now
 * persists on every message as `parent_run_id` — the value it always had in
 * hand at send time and used to throw away. The run it stores as `run_id` is
 * the child it mints per send, which is why a caller filtering on its own run
 * matched nothing and read a well-formed zero.
 *
 * An operation it has no messages for is a 404 carrying no stats, never zeros.
 * That is the distinction this whole path exists to preserve, so it is read
 * here as a first-class outcome rather than as an error.
 */
export interface ProviderOperationStats {
  operationRunId: string;
  messagesMatched: number;
  recipientsMatched: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  recipientStats: RecipientStats;
  emailStats: EmailStats;
}

export type OperationStatsResult =
  | { matched: true; stats: ProviderOperationStats }
  | { matched: false };

/**
 * Read one operation's outcomes, distinguishing "no messages under it" from
 * every other kind of failure.
 *
 * Deliberately not routed through `request()`: that helper turns any non-2xx
 * into a throw, which would flatten the 404 that carries the answer into the
 * same shape as a provider outage. Only `OPERATION_NOT_FOUND` is read as an
 * empty match; anything else still fails loud.
 */
export async function getOperationStats(operationRunId: string, ctx?: OrgContext): Promise<OperationStatsResult> {
  const path = `/internal/operations/${encodeURIComponent(operationRunId)}/stats`;
  const response = await fetch(`${url}${path}`, {
    method: "GET",
    headers: buildServiceHeaders(apiKey, ctx),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status === 404) {
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    if (body.code === "OPERATION_NOT_FOUND") return { matched: false };
    throw new Error(`postmark-service GET ${path}: 404 - ${JSON.stringify(body)}`);
  }

  if (!response.ok) {
    throw new Error(`postmark-service GET ${path}: ${response.status} - ${await response.text()}`);
  }

  return { matched: true, stats: (await response.json()) as ProviderOperationStats };
}

// StatusScope re-exported from shared contract.
export type { StatusScope } from "@shamanic-technologies/email-domain-contract";

export interface StatusResult {
  email: string;
  byCampaign: Record<string, StatusScope> | null;
  campaign: StatusScope | null;
  brand: StatusScope | null;
  global: GlobalStatus;
}

export async function getStatus(body: {
  brandId?: string;
  campaignId?: string;
  items: Array<{ email: string }>;
}, ctx?: OrgContext) {
  return request<{ results: StatusResult[] }>("/orgs/status", { method: "POST", body, ctx });
}

export async function forwardWebhook(body: unknown) {
  return request("/webhooks/postmark", { method: "POST", body });
}
