import { config } from "../config";

const { url, apiKey } = config.instantly;

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 500;

interface IdentityHeaders {
  orgId: string;
  userId: string;
  runId: string;
}

interface TrackingHeaders {
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; identityHeaders?: IdentityHeaders; trackingHeaders?: TrackingHeaders } = {}
): Promise<T> {
  const { method = "GET", body, identityHeaders, trackingHeaders } = options;
  const fullUrl = `${url}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    ...(identityHeaders && {
      "x-org-id": identityHeaders.orgId,
      "x-user-id": identityHeaders.userId,
      "x-run-id": identityHeaders.runId,
    }),
    ...(trackingHeaders?.campaignId && { "x-campaign-id": trackingHeaders.campaignId }),
    ...(trackingHeaders?.brandId && { "x-brand-id": trackingHeaders.brandId }),
    ...(trackingHeaders?.workflowName && { "x-workflow-name": trackingHeaders.workflowName }),
  };
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
  orgId?: string;
  userId?: string;
  brandId?: string;
  leadId?: string;
  runId?: string;
  workflowName?: string;
  campaignId?: string;
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
}, identityHeaders?: IdentityHeaders, trackingHeaders?: TrackingHeaders) {
  return request<AtomicSendResponse>("/send", { method: "POST", body, identityHeaders, trackingHeaders });
}

export interface ProviderStatsPayload {
  emailsSent: number;
  emailsDelivered: number;
  emailsOpened: number;
  emailsClicked: number;
  emailsReplied: number;
  emailsBounced: number;
  repliesAutoReply?: number;
  repliesWillingToMeet?: number;
  repliesInterested?: number;
  repliesNotInterested?: number;
  repliesOutOfOffice?: number;
  repliesUnsubscribe?: number;
}

export interface ProviderStepStats {
  step: number;
  emailsSent: number;
  emailsOpened: number;
  emailsReplied: number;
  emailsBounced: number;
}

export interface ProviderStatsFlat {
  stats: ProviderStatsPayload;
  recipients?: number;
  stepStats?: ProviderStepStats[];
}

export interface ProviderStatsGrouped {
  groups: Array<{
    key: string;
    stats: ProviderStatsPayload;
    recipients?: number;
  }>;
}

export type ProviderStatsResult = ProviderStatsFlat | ProviderStatsGrouped;

export async function getStats(filters: {
  runIds?: string[];
  orgId?: string;
  userId?: string;
  brandId?: string;
  campaignId?: string;
  workflowName?: string;
  groupBy?: string;
}, identityHeaders?: IdentityHeaders, trackingHeaders?: TrackingHeaders) {
  const path = identityHeaders ? "/stats" : "/stats/public";
  return request<ProviderStatsResult>(path, { method: "POST", body: filters, identityHeaders, trackingHeaders });
}

export interface StatusScope {
  lead: { contacted: boolean; delivered: boolean; replied: boolean; lastDeliveredAt: string | null };
  email: { contacted: boolean; delivered: boolean; bounced: boolean; unsubscribed: boolean; lastDeliveredAt: string | null };
}

export interface StatusResult {
  leadId: string;
  email: string;
  campaign: StatusScope | null;
  brand: StatusScope;
  global: { email: { bounced: boolean; unsubscribed: boolean } };
}

export async function getStatus(body: {
  brandId: string;
  campaignId?: string;
  items: Array<{ leadId: string; email: string }>;
}, identityHeaders?: IdentityHeaders, trackingHeaders?: TrackingHeaders) {
  return request<{ results: StatusResult[] }>("/status", { method: "POST", body, identityHeaders, trackingHeaders });
}

export async function forwardWebhook(body: unknown) {
  return request("/webhooks/instantly", { method: "POST", body });
}
