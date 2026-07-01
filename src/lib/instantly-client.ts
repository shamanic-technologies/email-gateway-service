import { config } from "../config";
import { buildServiceHeaders } from "./service-headers";
import type { OrgContext } from "../middleware/requireOrgId";
import type {
  RecipientStats,
  EmailStats,
  StepStats,
  ChannelStats,
  StatusScope,
  GlobalStatus,
} from "@shamanic-technologies/email-domain-contract";

const { url, apiKey } = config.instantly;

const TIMEOUT_MS = 10_000;
// The send path makes ~5 sequential Instantly.ai API calls, so it legitimately
// exceeds the default 10s. Scope a longer timeout to send only (not the GET
// stats/status calls, where 10s should stay tight enough to surface failures).
const SEND_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 500;

async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    ctx?: OrgContext;
    timeoutMs?: number;
    // Non-idempotent mutations (the send) must NOT auto-retry — a retry of a
    // succeeded-server-side send creates a duplicate Instantly campaign.
    retry?: boolean;
    idempotencyKey?: string;
  } = {}
): Promise<T> {
  const {
    method = "GET",
    body,
    ctx,
    timeoutMs = TIMEOUT_MS,
    retry = true,
    idempotencyKey,
  } = options;
  const fullUrl = `${url}${path}`;
  const headers = buildServiceHeaders(apiKey, ctx);
  // Forward the inbound idempotency key so instantly-service can dedupe a
  // duplicate send downstream (coordination point for its idempotency support).
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const jsonBody = body ? JSON.stringify(body) : undefined;

  const maxAttempts = retry ? 2 : 1;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(fullUrl, {
        method,
        headers,
        body: jsonBody,
        signal: AbortSignal.timeout(timeoutMs),
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
      if (attempt < maxAttempts - 1) {
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
  bcc?: string[];
  subject: string;
  // Recipient's IANA timezone (from the lead). instantly-service uses it to
  // schedule the sequence in the prospect's local business hours; absent =
  // instantly-service default tz.
  timezone?: string;
  sequence: Array<{
    step: number;
    bodyHtml: string;
    bodyText?: string;
    daysSinceLastStep: number;
  }>;
}, ctx?: OrgContext, idempotencyKey?: string) {
  // The send is non-idempotent (creates a campaign) and makes ~5 sequential
  // Instantly.ai calls. Use the longer send timeout, disable auto-retry, and
  // forward the idempotency key so a downstream dedupe is possible.
  return request<AtomicSendResponse>("/orgs/send", {
    method: "POST",
    body,
    ctx,
    timeoutMs: SEND_TIMEOUT_MS,
    retry: false,
    idempotencyKey,
  });
}

// Stats payload shapes — defined by the shared contract.
// Aliases preserved for backward compatibility with existing imports.
export type ProviderRepliesDetail = RecipientStats["repliesDetail"];
export type ProviderRecipientStats = RecipientStats;
export type ProviderStepStats = StepStats;
export type ProviderEmailStats = EmailStats;
export type ProviderStatsFlat = ChannelStats;

export interface ProviderStatsGrouped {
  groups: Array<{
    key: string;
    recipientStats: RecipientStats;
    emailStats: EmailStats;
  }>;
}

export type ProviderStatsResult = ProviderStatsFlat | ProviderStatsGrouped;

export interface EngagementLatencyMetric {
  averageMs: number | null;
  medianMs: number | null;
  sampleSize: number;
}

export interface ProviderEngagementLatencyGroup {
  key: string;
  workflowSlugs: string[];
  timeToFirstLinkClick: EngagementLatencyMetric;
  timeToFirstPositiveReply: EngagementLatencyMetric;
}

export interface ProviderEngagementLatencyGroupedResponse {
  groups: ProviderEngagementLatencyGroup[];
}

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
  timezone?: string;
}, ctx?: OrgContext) {
  const basePath = ctx?.orgId ? "/orgs/stats" : "/public/stats";
  const path = basePath + buildStatsQuery(filters);
  return request<ProviderStatsResult>(path, { ctx });
}

export async function getPublicEngagementLatencyGroups(groups: Record<string, { workflowSlugs: string[] }>) {
  return request<ProviderEngagementLatencyGroupedResponse>("/public/stats/engagement-latency/grouped", {
    method: "POST",
    body: { groups },
  });
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
  return request("/webhooks/instantly", { method: "POST", body });
}

// --- GET /internal/audit/sending-forecast ---
// Fleet-wide (no org) sending forecast. Passthrough shape — field names must be
// preserved exactly as instantly-service returns them (features-service depends
// on the byte-equal contract).
export interface SendingForecastDay {
  date: string;
  scheduledCount: number;
}

export interface SendingForecastResult {
  asOf: string;
  dailyCapacity: number;
  healthyAccountCount: number;
  totalAccountCount: number;
  blockedDomainCount: number;
  days: SendingForecastDay[];
}

export async function getSendingForecast(): Promise<SendingForecastResult> {
  // Fail loud on missing config — no silent fallback to a stub forecast.
  if (!config.instantly.apiKey) {
    throw new Error("INSTANTLY_SERVICE_API_KEY not configured");
  }
  // Platform-scoped internal call — no org context, authed with the shared
  // instantly-service API key (buildServiceHeaders sets X-API-Key from config).
  return request<SendingForecastResult>("/internal/audit/sending-forecast");
}
