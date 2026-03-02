import { config } from "../config";

const { url, apiKey } = config.postmark;

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 500;

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { method = "GET", body } = options;
  const fullUrl = `${url}${path}`;
  const fetchOptions: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(fullUrl, fetchOptions);

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
  orgId?: string;
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
