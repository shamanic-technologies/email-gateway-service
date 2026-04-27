import { config } from "../config";
import { buildServiceHeaders } from "./service-headers";
import type { OrgContext } from "../middleware/requireOrgId";

const { url, apiKey } = config.instantly;

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
          `instantly-service ${method} ${path}: ${response.status} - ${errorText}`
        );
      }

      return response.json() as Promise<T>;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Only retry on network-level errors (fetch failed, timeout), not HTTP errors
      if (lastError.message.includes("instantly-service")) throw lastError;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(
    `instantly-service ${method} ${path}: ${lastError?.message ?? "fetch failed"} (url: ${url})`
  );
}

export interface AtomicSendResponse {
  success: boolean;
  campaignId: string;
  leadId: string | null;
  added: number;
}

export async function atomicSend(body: {
  leadId?: string;
  to: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  variables?: Record<string, string>;
  subject: string;
  sequence: Array<{
    step: number;
    bodyHtml: string;
    bodyText?: string;
    daysSinceLastStep: number;
  }>;
}, ctx?: OrgContext) {
  return request<AtomicSendResponse>("/orgs/send", { method: "POST", body, ctx });
}

export interface ProviderRepliesDetail {
  interested: number;
  meetingBooked: number;
  closed: number;
  notInterested: number;
  wrongPerson: number;
  unsubscribe: number;
  neutral: number;
  autoReply: number;
  outOfOffice: number;
}

export interface ProviderRecipientStats {
  contacted: number;
  sent: number;
  delivered: number;
  opened: number;
  bounced: number;
  clicked: number;
  unsubscribed: number;
  repliesPositive: number;
  repliesNegative: number;
  repliesNeutral: number;
  repliesAutoReply: number;
  repliesDetail: ProviderRepliesDetail;
}

export interface ProviderStepStats {
  step: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  repliesPositive: number;
  repliesNegative: number;
  repliesNeutral: number;
  repliesAutoReply: number;
  repliesDetail: ProviderRepliesDetail;
}

export interface ProviderEmailStats {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  stepStats?: ProviderStepStats[];
}

export interface ProviderStatsFlat {
  recipientStats: ProviderRecipientStats;
  emailStats: ProviderEmailStats;
}

export interface ProviderStatsGrouped {
  groups: Array<{
    key: string;
    recipientStats: ProviderRecipientStats;
    emailStats: ProviderEmailStats;
  }>;
}

export type ProviderStatsResult = ProviderStatsFlat | ProviderStatsGrouped;

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
  const basePath = ctx?.orgId ? "/orgs/stats" : "/public/stats";
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
  return request("/webhooks/instantly", { method: "POST", body });
}
