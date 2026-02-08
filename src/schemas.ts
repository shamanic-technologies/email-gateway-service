import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Enums ---

export const EmailTypeSchema = z.enum(["transactional", "broadcast"]);
export type EmailType = z.infer<typeof EmailTypeSchema>;

// --- POST /send ---

export const SendRequestSchema = z
  .object({
    type: EmailTypeSchema,
    // context (mandatory)
    appId: z.string(),
    clerkOrgId: z.string(),
    brandId: z.string(),
    campaignId: z.string(),
    clerkUserId: z.string().optional(),
    // recipient (mandatory)
    to: z.string().email(),
    recipientFirstName: z.string(),
    recipientLastName: z.string(),
    recipientCompany: z.string(),
    // email content
    subject: z.string(),
    htmlBody: z.string().optional(),
    textBody: z.string().optional(),
    // optional
    replyTo: z.string().email().optional(),
    tag: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .openapi("SendRequest");

export type SendRequest = z.infer<typeof SendRequestSchema>;

export const SendResponseSchema = z
  .object({
    success: z.boolean(),
    messageId: z.string().optional(),
    provider: EmailTypeSchema,
    error: z.string().optional(),
  })
  .openapi("SendResponse");

export type SendResponse = z.infer<typeof SendResponseSchema>;

// --- POST /stats ---

export const StatsRequestSchema = z
  .object({
    type: EmailTypeSchema.optional(),
    runIds: z.array(z.string()).optional(),
    clerkOrgId: z.string().optional(),
    brandId: z.string().optional(),
    appId: z.string().optional(),
    campaignId: z.string().optional(),
  })
  .openapi("StatsRequest");

export type StatsRequest = z.infer<typeof StatsRequestSchema>;

export const StatsSchema = z
  .object({
    sent: z.number(),
    delivered: z.number(),
    opened: z.number(),
    clicked: z.number(),
    replied: z.number(),
    bounced: z.number(),
    unsubscribed: z.number(),
    recipients: z.number(),
  })
  .openapi("Stats");

export type Stats = z.infer<typeof StatsSchema>;

export const StatsResponseSchema = z
  .object({
    transactional: StatsSchema.optional(),
    broadcast: StatsSchema.optional(),
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

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
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
  summary: "Send an email (transactional or broadcast)",
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
    400: { description: "Invalid request" },
    401: { description: "Unauthorized" },
    502: { description: "Upstream service error" },
  },
});

registry.registerPath({
  method: "post",
  path: "/stats",
  summary: "Get aggregated email stats",
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
    401: { description: "Unauthorized" },
    502: { description: "Upstream service error" },
  },
});

registry.registerPath({
  method: "post",
  path: "/webhooks/postmark",
  summary: "Forward Postmark webhook events",
  responses: {
    200: { description: "Webhook forwarded" },
    502: { description: "Upstream service error" },
  },
});

registry.registerPath({
  method: "post",
  path: "/webhooks/instantly",
  summary: "Forward Instantly webhook events",
  responses: {
    200: { description: "Webhook forwarded" },
    502: { description: "Upstream service error" },
  },
});
