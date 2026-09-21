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
  options: { method?: string; body?: unknown; ctx?: OrgContext; nullOn404Code?: string } = {}
): Promise<T> {
  const { method = "GET", body, ctx, nullOn404Code } = options;
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
        // A 404 is only a legitimate answer when the provider NAMES the case it
        // is answering. A bare 404 (a withdrawn route, a typo'd path) must stay
        // an error: flattening it would turn "this read no longer exists" into
        // "this operation has nothing", which is the exact confusion this whole
        // path exists to prevent.
        if (response.status === 404 && nullOn404Code) {
          let code: unknown;
          try {
            code = (JSON.parse(errorText) as { code?: unknown }).code;
          } catch {
            code = undefined;
          }
          if (code === nullOn404Code) return null as T;
        }
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
  cc?: string;
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
 * Keyed on the OPERATION RUN — the `x-run-id` the caller performed the sends
 * under, which postmark-service now persists as each message's `parent_run_id`.
 * The earlier tag-keyed read (`/stats/by-tag`) was withdrawn before it reached
 * prod: a tag is per-TEMPLATE, so one release's question returned every past
 * release's messages.
 *
 * An operation the provider has nothing under is a 404 carrying
 * `code: OPERATION_NOT_FOUND` and NO stats block — returned here as `null`, so
 * an empty match can never be read as a measured zero. Service-auth route only;
 * there is no org-scoped variant, and the gateway holds the service key.
 */
export interface ProviderOperationStats {
  operationRunId: string;
  messagesMatched: number;
  recipientsMatched: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  recipientStats?: RecipientStats;
  emailStats?: EmailStats;
}

export async function getOperationStats(operationRunId: string, ctx?: OrgContext) {
  const path = `/internal/operations/${encodeURIComponent(operationRunId)}/stats`;
  return request<ProviderOperationStats | null>(path, { ctx, nullOn404Code: "OPERATION_NOT_FOUND" });
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
