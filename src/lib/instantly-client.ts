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

export async function atomicSend(body: {
  orgId?: string;
  brandId: string;
  appId: string;
  runId?: string;
  campaignId: string;
  to: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  variables?: Record<string, string>;
  email: {
    subject: string;
    body: string;
  };
}) {
  return request("/send", { method: "POST", body });
}

export async function getStats(filters: {
  runIds?: string[];
  clerkOrgId?: string;
  brandId?: string;
  appId?: string;
  campaignId?: string;
}) {
  return request<{
    stats: {
      totalLeads: number;
      contacted: number;
      opened: number;
      replied: number;
      bounced: number;
      unsubscribed: number;
    };
  }>("/stats", { method: "POST", body: filters });
}

export async function forwardWebhook(body: unknown) {
  return request("/webhooks/instantly", { method: "POST", body });
}
