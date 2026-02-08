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
  brandId: string;
  appId: string;
  campaignId: string;
  from: string;
  to: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  replyTo?: string;
  tag?: string;
  metadata?: Record<string, string>;
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
      emailsSent: number;
      emailsDelivered: number;
      emailsOpened: number;
      emailsClicked: number;
      emailsReplied: number;
      emailsBounced: number;
    };
  }>("/stats", { method: "POST", body: filters });
}

export async function forwardWebhook(body: unknown) {
  return request("/webhooks/postmark", { method: "POST", body });
}
