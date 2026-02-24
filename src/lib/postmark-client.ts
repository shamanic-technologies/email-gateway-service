import { config } from "../config";

const { url, apiKey } = config.postmark;

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
      `postmark-service ${method} ${path}: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<T>;
}

export async function sendEmail(body: {
  orgId?: string;
  runId?: string;
  brandId?: string;
  appId: string;
  leadId?: string;
  workflowName?: string;
  campaignId?: string;
  from: string;
  to: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  replyTo?: string;
  tag?: string;
  metadata?: Record<string, string>;
  messageStream?: string;
}) {
  return request<{
    success: boolean;
    messageId?: string;
    submittedAt?: string;
    sendingId?: string;
    errorCode?: number;
    message?: string;
  }>("/send", { method: "POST", body });
}

// Re-export shared provider types from instantly-client
import type { ProviderStatsResult } from "./instantly-client";

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
  return request("/webhooks/postmark", { method: "POST", body });
}
