import { config } from "../config";

const { url, apiKey } = config.instantly;

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { method = "GET", body } = options;
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `instantly-service ${method} ${path}: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<T>;
}

export interface AtomicSendResponse {
  success: boolean;
  campaignId: string;
  leadId: string | null;
  added: number;
}

export async function atomicSend(body: {
  orgId?: string;
  brandId?: string;
  appId: string;
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
}) {
  return request<AtomicSendResponse>("/send", { method: "POST", body });
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
  clerkOrgId?: string;
  brandId?: string;
  appId?: string;
  campaignId?: string;
  workflowName?: string;
  groupBy?: string;
}) {
  return request<ProviderStatsResult>("/stats", { method: "POST", body: filters });
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
}) {
  return request<{ results: StatusResult[] }>("/status", { method: "POST", body });
}

export async function forwardWebhook(body: unknown) {
  return request("/webhooks/instantly", { method: "POST", body });
}
