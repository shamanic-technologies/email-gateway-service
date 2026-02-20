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

const SendBaseSchema = z.object({
  appId: z.string().describe("App ID"),
  clerkOrgId: z.string().optional().describe("Clerk organization ID"),
  brandId: z.string().optional().describe("Brand ID"),
  campaignId: z.string().optional().describe("Campaign ID"),
  runId: z.string().describe("Run ID for tracking"),
  workflowName: z.string().optional().describe("Workflow name for tracking and grouping"),
  clerkUserId: z.string().optional().describe("Clerk user ID"),
  to: z.string().email().describe("Recipient email address"),
  recipientFirstName: z.string().describe("Recipient first name"),
  recipientLastName: z.string().describe("Recipient last name"),
  recipientCompany: z.string().describe("Recipient company name"),
  replyTo: z.string().email().optional().describe("Reply-to email address"),
  tag: z.string().optional().describe("Email tag for categorization"),
  metadata: z.record(z.string(), z.string()).optional().describe("Custom metadata key-value pairs"),
  idempotencyKey: z.string().optional().describe("Idempotency key to prevent duplicate sends (e.g. runId). If a send with the same key already succeeded, the previous result is returned without re-sending."),
});

export const SequenceStepSchema = z
  .object({
    step: z.number().int().min(1).describe("Step number (1-based ordinal)"),
    bodyHtml: z.string().describe("HTML email body for this step"),
    bodyText: z.string().optional().describe("Plain text email body for this step"),
    daysSinceLastStep: z.number().int().min(0).describe("Days to wait since the previous step (0 = immediate, step 1 is always 0)"),
  })
  .openapi("SequenceStep");

export type SequenceStep = z.infer<typeof SequenceStepSchema>;

const TransactionalSendSchema = SendBaseSchema.extend({
  type: z.literal("transactional").describe("Transactional email channel"),
  subject: z.string().describe("Email subject line"),
  htmlBody: z.string().optional().describe("HTML email body"),
  textBody: z.string().optional().describe("Plain text email body"),
});

const BroadcastSendSchema = SendBaseSchema.extend({
  type: z.literal("broadcast").describe("Broadcast email channel"),
  subject: z.string().describe("Shared email subject line (same thread, follow-ups are Re:)"),
  sequence: z.array(SequenceStepSchema).min(1).describe("Email sequence steps sent via Instantly"),
});

export const SendRequestSchema = z
  .discriminatedUnion("type", [TransactionalSendSchema, BroadcastSendSchema])
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

export const GroupByDimensionSchema = z.enum(["brandId", "campaignId", "workflowName", "leadEmail"]);
export type GroupByDimension = z.infer<typeof GroupByDimensionSchema>;

export const StatsRequestSchema = z
  .object({
    type: EmailTypeSchema.optional().describe("Filter by email channel type"),
    runIds: z.array(z.string()).optional().describe("Filter by run IDs"),
    clerkOrgId: z.string().optional().describe("Filter by Clerk organization ID"),
    brandId: z.string().optional().describe("Filter by brand ID"),
    appId: z.string().optional().describe("Filter by app ID"),
    campaignId: z.string().optional().describe("Filter by campaign ID"),
    workflowName: z.string().optional().describe("Filter by workflow name"),
    groupBy: GroupByDimensionSchema.optional().describe("Group results by dimension. When set, response is { groups: [...] } instead of flat stats."),
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

export const StepStatsSchema = z
  .object({
    step: z.number().describe("Step number"),
    emailsSent: z.number().describe("Emails sent for this step"),
    emailsOpened: z.number().describe("Emails opened for this step"),
    emailsReplied: z.number().describe("Replies for this step"),
    emailsBounced: z.number().describe("Bounces for this step"),
  })
  .openapi("StepStats");

export type StepStats = z.infer<typeof StepStatsSchema>;

export const BroadcastStatsSchema = StatsSchema.extend({
  stepStats: z.array(StepStatsSchema).optional().describe("Per-step breakdown (broadcast sequences only)"),
}).openapi("BroadcastStats");

export type BroadcastStats = z.infer<typeof BroadcastStatsSchema>;

export const StatsResponseSchema = z
  .object({
    transactional: StatsSchema.optional().describe("Stats for transactional emails"),
    broadcast: BroadcastStatsSchema.optional().describe("Stats for broadcast emails"),
  })
  .openapi("StatsResponse");

export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const StatsGroupSchema = z
  .object({
    key: z.string().describe("Value of the groupBy dimension for this group"),
    transactional: StatsSchema.optional().describe("Transactional stats for this group"),
    broadcast: StatsSchema.optional().describe("Broadcast stats for this group"),
  })
  .openapi("StatsGroup");

export type StatsGroup = z.infer<typeof StatsGroupSchema>;

export const GroupedStatsResponseSchema = z
  .object({
    groups: z.array(StatsGroupSchema).describe("Stats grouped by the requested dimension"),
  })
  .openapi("GroupedStatsResponse");

export type GroupedStatsResponse = z.infer<typeof GroupedStatsResponseSchema>;

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
  description: "Get aggregated email stats. Without groupBy: returns flat { transactional?, broadcast? }. With groupBy: returns { groups: [{ key, transactional?, broadcast? }] }.",
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
