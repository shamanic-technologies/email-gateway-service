import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Security ---

registry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "X-API-Key",
  description: "Service-to-service API key",
});

// --- Shared schemas ---

export const ErrorResponseSchema = z
  .object({
    error: z.string().describe("Error message"),
    details: z.string().optional().describe("Additional error details"),
  })
  .openapi("ErrorResponse");

// --- Enums ---

export const EmailTypeSchema = z.enum(["transactional", "broadcast"]);
export type EmailType = z.infer<typeof EmailTypeSchema>;

// --- POST /send ---

export const SendRequestSchema = z
  .object({
    type: EmailTypeSchema.describe("Email channel type"),
    appId: z.string().describe("App ID"),
    clerkOrgId: z.string().optional().describe("Clerk organization ID"),
    brandId: z.string().optional().describe("Brand ID"),
    campaignId: z.string().optional().describe("Campaign ID"),
    runId: z.string().describe("Run ID for tracking"),
    clerkUserId: z.string().optional().describe("Clerk user ID"),
    to: z.string().email().describe("Recipient email address"),
    recipientFirstName: z.string().describe("Recipient first name"),
    recipientLastName: z.string().describe("Recipient last name"),
    recipientCompany: z.string().describe("Recipient company name"),
    subject: z.string().describe("Email subject line"),
    htmlBody: z.string().optional().describe("HTML email body"),
    textBody: z.string().optional().describe("Plain text email body"),
    replyTo: z.string().email().optional().describe("Reply-to email address"),
    tag: z.string().optional().describe("Email tag for categorization"),
    metadata: z.record(z.string(), z.string()).optional().describe("Custom metadata key-value pairs"),
    idempotencyKey: z.string().optional().describe("Idempotency key to prevent duplicate sends (e.g. runId). If a send with the same key already succeeded, the previous result is returned without re-sending."),
  })
  .openapi("SendRequest");

export type SendRequest = z.infer<typeof SendRequestSchema>;

export const SendResponseSchema = z
  .object({
    success: z.boolean().describe("Whether the email was sent successfully"),
    messageId: z.string().optional().describe("Provider message ID (Postmark messageId or Instantly leadId)"),
    provider: EmailTypeSchema.describe("Provider that handled the email"),
    campaignId: z.string().optional().describe("Instantly campaign ID (broadcast only)"),
    error: z.string().optional().describe("Error message if send failed"),
    deduplicated: z.boolean().optional().describe("True if this response was returned from the idempotency cache (email was not re-sent)"),
  })
  .openapi("SendResponse");

export type SendResponse = z.infer<typeof SendResponseSchema>;

// --- POST /stats ---

export const StatsRequestSchema = z
  .object({
    type: EmailTypeSchema.optional().describe("Filter by email channel type"),
    runIds: z.array(z.string()).optional().describe("Filter by run IDs"),
    clerkOrgId: z.string().optional().describe("Filter by Clerk organization ID"),
    brandId: z.string().optional().describe("Filter by brand ID"),
    appId: z.string().optional().describe("Filter by app ID"),
    campaignId: z.string().optional().describe("Filter by campaign ID"),
  })
  .openapi("StatsRequest");

export type StatsRequest = z.infer<typeof StatsRequestSchema>;

export const StatsSchema = z
  .object({
    emailsSent: z.number().describe("Total emails sent"),
    emailsDelivered: z.number().describe("Total emails delivered"),
    emailsOpened: z.number().describe("Total emails opened"),
    emailsClicked: z.number().describe("Total link clicks"),
    emailsReplied: z.number().describe("Total replies received"),
    emailsBounced: z.number().describe("Total bounced emails"),
    repliesWillingToMeet: z.number().describe("Replies willing to meet"),
    repliesInterested: z.number().describe("Replies interested"),
    repliesNotInterested: z.number().describe("Replies not interested"),
    repliesOutOfOffice: z.number().describe("Replies out of office"),
    repliesUnsubscribe: z.number().describe("Total unsubscribes"),
    recipients: z.number().describe("Total unique recipients"),
  })
  .openapi("Stats");

export type Stats = z.infer<typeof StatsSchema>;

export const StatsResponseSchema = z
  .object({
    transactional: StatsSchema.optional().describe("Stats for transactional emails"),
    broadcast: StatsSchema.optional().describe("Stats for broadcast emails"),
  })
  .openapi("StatsResponse");

export type StatsResponse = z.infer<typeof StatsResponseSchema>;

// --- Health ---

export const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
    version: z.string(),
  })
  .openapi("HealthResponse");

// --- Register endpoints ---

const errorContent = {
  "application/json": { schema: ErrorResponseSchema },
};

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Health check",
  description: "Returns service health status",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/send",
  tags: ["Email Routing"],
  summary: "Send an email",
  description: "Send a transactional or broadcast email via the appropriate provider",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: SendRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Email sent successfully",
      content: { "application/json": { schema: SendResponseSchema } },
    },
    400: { description: "Invalid request", content: errorContent },
    401: { description: "Unauthorized", content: errorContent },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "post",
  path: "/stats",
  tags: ["Stats"],
  summary: "Get aggregated email stats",
  description: "Get aggregated email stats filtered by type, runIds, clerkOrgId, brandId, appId, and/or campaignId",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: StatsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Aggregated stats",
      content: { "application/json": { schema: StatsResponseSchema } },
    },
    401: { description: "Unauthorized", content: errorContent },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "post",
  path: "/webhooks/postmark",
  tags: ["Webhooks"],
  summary: "Forward Postmark webhook events",
  description: "Receives Postmark webhook events and forwards them to the upstream postmark service",
  responses: {
    200: { description: "Webhook forwarded" },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "post",
  path: "/webhooks/instantly",
  tags: ["Webhooks"],
  summary: "Forward Instantly webhook events",
  description: "Receives Instantly webhook events and forwards them to the upstream instantly service",
  responses: {
    200: { description: "Webhook forwarded" },
    502: { description: "Upstream service error", content: errorContent },
  },
});
