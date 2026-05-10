import { config } from "../config";
import { buildServiceHeaders } from "./service-headers";
import type { OrgContext } from "../middleware/requireOrgId";

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

export interface StatusScope {
  contacted: boolean;
  delivered: boolean;
  opened: boolean;
  replied: boolean;
  replyClassification: "positive" | "negative" | "neutral" | null;
  bounced: boolean;
  unsubscribed: boolean;
  lastDeliveredAt: string | null;
}

export interface StatusResult {
  email: string;
  byCampaign: Record<string, StatusScope> | null;
  campaign: StatusScope | null;
  brand: StatusScope | null;
  global: { email: { bounced: boolean; unsubscribed: boolean } };
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
