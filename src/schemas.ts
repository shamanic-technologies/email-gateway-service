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

// --- POST /orgs/send ---

const SendBaseSchema = z.object({
  campaignId: z.string().optional().describe("Campaign ID for tracking and stats grouping"),
  leadId: z.string().optional().describe("Lead ID for end-to-end tracking. When provided: logged on receipt, forwarded to the downstream provider (Postmark/Instantly), and returned as `messageId` in the response for broadcast sends. Omitting it means email stats cannot be correlated back to the lead."),
  workflowSlug: z.string().optional().describe("Workflow slug for tracking and grouping"),
  to: z.string({ required_error: "to (recipient email) is required — the lead has no email address", invalid_type_error: "to (recipient email) must be a string, got null — the lead has no email address" }).email("to must be a valid email address").describe("Recipient email address"),
  recipientFirstName: z.string({ required_error: "recipientFirstName is required", invalid_type_error: "recipientFirstName must be a string" }).describe("Recipient first name"),
  recipientLastName: z.string({ required_error: "recipientLastName is required", invalid_type_error: "recipientLastName must be a string" }).describe("Recipient last name"),
  recipientCompany: z.string({ required_error: "recipientCompany is required", invalid_type_error: "recipientCompany must be a string" }).describe("Recipient company name"),
  replyTo: z.string().email().optional().describe("Reply-to email address"),
  tag: z.string().optional().describe("Email tag for categorization"),
  metadata: z.record(z.string(), z.string()).optional().describe("Custom metadata key-value pairs"),
  idempotencyKey: z.string().optional().describe("Unique key to prevent duplicate sends. If a send with the same key already succeeded, the cached response is returned with `deduplicated: true` and no email is re-sent. Use a value unique per send attempt — e.g. the run ID, or a composite like `{runId}:{nodeId}` when a single workflow run triggers multiple sends."),
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
  from: z.string().optional().describe("Sender address, e.g. \"Display Name <email@domain.com>\". If omitted, the downstream provider resolves its own default."),
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

// --- Stats ---

export const GroupByDimensionSchema = z.enum(["brandId", "campaignId", "workflowSlug", "featureSlug", "leadEmail", "workflowDynastySlug", "featureDynastySlug"]);
export type GroupByDimension = z.infer<typeof GroupByDimensionSchema>;

export const StatsQuerySchema = z
  .object({
    type: EmailTypeSchema.optional().describe("Filter by email channel type"),
    runIds: z.string().optional().describe("Comma-separated run IDs"),
    brandIds: z.string().optional().describe("Comma-separated brand IDs to filter by"),
    campaignId: z.string().optional().describe("Filter by campaign ID"),
    workflowSlugs: z.string().optional().describe("Comma-separated workflow slugs to filter by"),
    featureSlugs: z.string().optional().describe("Comma-separated feature slugs to filter by"),
    workflowDynastySlug: z.string().optional().describe("Filter by workflow dynasty slug (resolved to all versioned slugs)"),
    featureDynastySlug: z.string().optional().describe("Filter by feature dynasty slug (resolved to all versioned slugs)"),
    groupBy: GroupByDimensionSchema.optional().describe("Group results by dimension"),
  })
  .openapi("StatsQuery");

export type StatsQuery = z.infer<typeof StatsQuerySchema>;

export const RepliesDetailSchema = z
  .object({
    interested: z.number().describe("Replies classified as interested"),
    meetingBooked: z.number().describe("Replies where a meeting was booked"),
    closed: z.number().describe("Replies classified as closed/won"),
    notInterested: z.number().describe("Replies not interested"),
    wrongPerson: z.number().describe("Replies from wrong person"),
    unsubscribe: z.number().describe("Unsubscribe replies"),
    neutral: z.number().describe("Neutral replies"),
    autoReply: z.number().describe("Auto-reply messages"),
    outOfOffice: z.number().describe("Out of office replies"),
  })
  .openapi("RepliesDetail");

export type RepliesDetail = z.infer<typeof RepliesDetailSchema>;

export const StatsSchema = z
  .object({
    emailsContacted: z.number().describe("Total leads contacted (added to campaign / send attempted)"),
    emailsSent: z.number().describe("Total emails sent"),
    emailsDelivered: z.number().describe("Total emails delivered"),
    emailsOpened: z.number().describe("Total emails opened"),
    emailsClicked: z.number().describe("Total link clicks"),
    emailsReplied: z.number().describe("All human replies (excludes auto-replies)"),
    emailsBounced: z.number().describe("Total bounced emails"),
    repliesPositive: z.number().describe("Aggregate: interested + meetingBooked + closed"),
    repliesNegative: z.number().describe("Aggregate: notInterested + wrongPerson + unsubscribe"),
    repliesNeutral: z.number().describe("Aggregate: neutral"),
    repliesAutoReply: z.number().describe("Aggregate: autoReply + outOfOffice"),
    repliesDetail: RepliesDetailSchema.describe("Individual reply counts (9 categories)"),
    recipients: z.number().describe("Total unique recipients"),
  })
  .openapi("Stats");

export type Stats = z.infer<typeof StatsSchema>;

export const StepStatsSchema = z
  .object({
    step: z.number().describe("Step number"),
    emailsSent: z.number().describe("Emails sent for this step"),
    emailsOpened: z.number().describe("Emails opened for this step"),
    emailsReplied: z.number().describe("All human replies for this step"),
    emailsBounced: z.number().describe("Bounces for this step"),
    repliesPositive: z.number().describe("Aggregate: interested + meetingBooked + closed"),
    repliesNegative: z.number().describe("Aggregate: notInterested + wrongPerson + unsubscribe"),
    repliesNeutral: z.number().describe("Aggregate: neutral"),
    repliesAutoReply: z.number().describe("Aggregate: autoReply + outOfOffice"),
    repliesDetail: RepliesDetailSchema.describe("Individual reply counts for this step"),
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
    key: z.string().describe("The value of the groupBy dimension for this bucket. When groupBy=brandId this is the brand UUID; when groupBy=campaignId it is the campaign UUID; when groupBy=workflowSlug it is the workflow slug string; etc."),
    transactional: StatsSchema.optional().describe("Transactional (Postmark) stats for this group. Omitted when type=broadcast or when no transactional data exists for this key."),
    broadcast: StatsSchema.optional().describe("Broadcast (Instantly) stats for this group. Omitted when type=transactional or when no broadcast data exists for this key."),
  })
  .openapi("StatsGroup", {
    example: {
      key: "b47ac10b-58cc-4372-a567-0e02b2c3d479",
      broadcast: {
        emailsContacted: 150,
        emailsSent: 120,
        emailsDelivered: 115,
        emailsOpened: 45,
        emailsClicked: 12,
        emailsReplied: 8,
        emailsBounced: 5,
        repliesPositive: 3,
        repliesNegative: 2,
        repliesNeutral: 0,
        repliesAutoReply: 2,
        repliesDetail: {
          interested: 2, meetingBooked: 1, closed: 0,
          notInterested: 1, wrongPerson: 0, unsubscribe: 1,
          neutral: 0, autoReply: 1, outOfOffice: 1,
        },
        recipients: 150,
      },
    },
  });

export type StatsGroup = z.infer<typeof StatsGroupSchema>;

export const GroupedStatsResponseSchema = z
  .object({
    groups: z.array(StatsGroupSchema).describe("One entry per unique value of the groupBy dimension. Each entry contains the key and the stats for that bucket."),
  })
  .openapi("GroupedStatsResponse", {
    description: "Returned instead of StatsResponse when the groupBy query parameter is set. Groups stats by the requested dimension (brandId, campaignId, workflowSlug, featureSlug, or leadEmail).",
    example: {
      groups: [
        {
          key: "b47ac10b-58cc-4372-a567-0e02b2c3d479",
          broadcast: {
            emailsContacted: 150, emailsSent: 120, emailsDelivered: 115,
            emailsOpened: 45, emailsClicked: 12, emailsReplied: 8,
            emailsBounced: 5, repliesPositive: 3, repliesNegative: 2,
            repliesNeutral: 0, repliesAutoReply: 2,
            repliesDetail: {
              interested: 2, meetingBooked: 1, closed: 0,
              notInterested: 1, wrongPerson: 0, unsubscribe: 1,
              neutral: 0, autoReply: 1, outOfOffice: 1,
            },
            recipients: 150,
          },
        },
        {
          key: "c58bd21c-69dd-4483-b678-1f13c3d4e590",
          broadcast: {
            emailsContacted: 80, emailsSent: 70, emailsDelivered: 65,
            emailsOpened: 20, emailsClicked: 5, emailsReplied: 3,
            emailsBounced: 2, repliesPositive: 1, repliesNegative: 0,
            repliesNeutral: 0, repliesAutoReply: 1,
            repliesDetail: {
              interested: 1, meetingBooked: 0, closed: 0,
              notInterested: 0, wrongPerson: 0, unsubscribe: 0,
              neutral: 0, autoReply: 0, outOfOffice: 1,
            },
            recipients: 80,
          },
        },
      ],
    },
  });

export type GroupedStatsResponse = z.infer<typeof GroupedStatsResponseSchema>;

// --- POST /orgs/status ---

export const ReplyClassificationSchema = z.enum(["positive", "negative", "neutral"]).openapi("ReplyClassification");

const StatusScopeSchema = z
  .object({
    contacted: z.boolean().describe("Whether this email has been contacted in this scope"),
    delivered: z.boolean().describe("Whether an email was delivered in this scope"),
    opened: z.boolean().describe("Whether the recipient opened any email in this scope"),
    replied: z.boolean().describe("Whether the recipient replied in this scope"),
    replyClassification: ReplyClassificationSchema.nullable().describe("Classification of the most recent reply: positive, negative, neutral, or null if no reply"),
    bounced: z.boolean().describe("Whether an email bounced in this scope"),
    unsubscribed: z.boolean().describe("Whether the recipient unsubscribed in this scope"),
    lastDeliveredAt: z.string().nullable().describe("ISO timestamp of last delivery in this scope"),
  })
  .openapi("StatusScope", {
    example: {
      contacted: true,
      delivered: true,
      opened: true,
      replied: true,
      replyClassification: "positive",
      bounced: false,
      unsubscribed: false,
      lastDeliveredAt: "2026-03-02T12:00:00.000Z",
    },
  });

const GlobalStatusSchema = z
  .object({
    email: z.object({
      bounced: z.boolean().describe("Whether this email has bounced anywhere"),
      unsubscribed: z.boolean().describe("Whether this email has unsubscribed anywhere"),
    }).describe("Global email signals (technical/legal)"),
  })
  .openapi("GlobalStatus", {
    example: { email: { bounced: false, unsubscribed: false } },
  });

const ProviderStatusSchema = z
  .object({
    byCampaign: z.record(z.string(), StatusScopeSchema).nullable().describe("Per-campaign breakdown (present in brand mode, null in campaign mode)"),
    campaign: StatusScopeSchema.nullable().describe("Status scoped to the given campaign (present in campaign mode, null in brand mode)"),
    brand: StatusScopeSchema.nullable().describe("Aggregated status across all campaigns for this brand (present in brand mode, null in campaign mode)"),
    global: GlobalStatusSchema.describe("Global signals across all brands and campaigns"),
  })
  .openapi("ProviderStatus");

const StatusResultSchema = z
  .object({
    email: z.string().describe("Recipient email address"),
    broadcast: ProviderStatusSchema.optional().describe("Status from broadcast provider (Instantly). Omitted if no broadcast data exists for this email."),
    transactional: ProviderStatusSchema.optional().describe("Status from transactional provider (Postmark). Omitted if no transactional data exists for this email."),
  })
  .openapi("StatusResult");

export const StatusItemSchema = z.object({
  email: z.string().email().describe("Recipient email address"),
});

export const StatusRequestSchema = z
  .object({
    brandId: z.string().optional().describe("Brand ID — if present without campaignId, activates brand mode: returns per-campaign breakdown (byCampaign) + aggregated brand status. If both brandId and campaignId are provided, campaign mode takes precedence and brandId is ignored."),
    campaignId: z.string().optional().describe("Campaign ID — if present, activates campaign mode: returns status scoped to this specific campaign. Takes precedence over brandId."),
    items: z.array(StatusItemSchema).min(1).describe("List of emails to check status for"),
  })
  .refine(
    (data) => data.brandId !== undefined || data.campaignId !== undefined,
    { message: "At least one of brandId or campaignId is required" }
  )
  .openapi("StatusRequest");

export type StatusRequest = z.infer<typeof StatusRequestSchema>;

export const StatusResponseSchema = z
  .object({
    results: z.array(StatusResultSchema).describe("Status results per item"),
  })
  .openapi("StatusResponse");

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// --- Health ---

export const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
    version: z.string(),
  })
  .openapi("HealthResponse");

// --- Identity headers ---

/** Headers for org-scoped routes: only x-org-id is required */
export const OrgScopedHeadersSchema = z.object({
  "x-org-id": z.string().describe("Internal organization UUID from client-service"),
  "x-user-id": z.string().optional().describe("Internal user UUID from client-service"),
  "x-run-id": z.string().optional().describe("Caller's run ID (used as parentRunId when creating own run)"),
  "x-campaign-id": z.string().optional().describe("Campaign ID injected by workflow-service (optional, used for tracking)"),
  "x-brand-id": z.string().optional().describe("Comma-separated brand IDs injected by workflow-service (e.g. \"uuid1,uuid2,uuid3\")"),
  "x-workflow-slug": z.string().optional().describe("Workflow slug injected by workflow-service (optional, used for tracking)"),
  "x-feature-slug": z.string().optional().describe("Feature slug for tracking (optional, propagated through the chain)"),
});


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
  path: "/orgs/send",
  tags: ["Email Routing"],
  summary: "Send an email",
  description: "Send a transactional or broadcast email via the appropriate provider.",
  security: [{ apiKey: [] }],
  request: {
    headers: OrgScopedHeadersSchema,
    body: {
      content: {
        "application/json": {
          schema: SendRequestSchema,
          examples: {
            transactional: {
              summary: "Transactional email with idempotency and lead tracking",
              value: {
                type: "transactional",
                to: "alice@media.com",
                recipientFirstName: "Alice",
                recipientLastName: "Martin",
                recipientCompany: "Media Corp",
                subject: "Your PR coverage report is ready",
                htmlBody: "<p>Hi Alice, your report is attached.</p>",
                leadId: "a1b2c3d4-5678-9abc-def0-1234567890ab",
                idempotencyKey: "run-abc123:email-send",
                campaignId: "b47ac10b-58cc-4372-a567-0e02b2c3d479",
              },
            },
            broadcast: {
              summary: "Broadcast sequence with lead tracking",
              value: {
                type: "broadcast",
                to: "bob@press.org",
                recipientFirstName: "Bob",
                recipientLastName: "Jones",
                recipientCompany: "Press Daily",
                subject: "Exclusive story opportunity",
                leadId: "f9e8d7c6-5432-1abc-def0-abcdef012345",
                idempotencyKey: "run-xyz789:email-send",
                campaignId: "c58bd21c-69dd-4483-b678-1f13c3d4e590",
                sequence: [
                  { step: 1, bodyHtml: "<p>Hi Bob, I have a story for you.</p>", daysSinceLastStep: 0 },
                  { step: 2, bodyHtml: "<p>Just following up on my previous email.</p>", daysSinceLastStep: 3 },
                ],
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "Email sent successfully",
      content: {
        "application/json": {
          schema: SendResponseSchema,
          examples: {
            transactionalSuccess: {
              summary: "Transactional send — success",
              value: {
                success: true,
                messageId: "e8b2d4f6-1234-5678-abcd-ef0123456789",
                provider: "transactional",
              },
            },
            broadcastSuccess: {
              summary: "Broadcast send — success (messageId is the Instantly leadId)",
              value: {
                success: true,
                messageId: "f9e8d7c6-5432-1abc-def0-abcdef012345",
                provider: "broadcast",
                campaignId: "c58bd21c-69dd-4483-b678-1f13c3d4e590",
              },
            },
            deduplicated: {
              summary: "Idempotency hit — cached response returned, no email re-sent",
              value: {
                success: true,
                messageId: "e8b2d4f6-1234-5678-abcd-ef0123456789",
                provider: "transactional",
                deduplicated: true,
              },
            },
          },
        },
      },
    },
    400: { description: "Invalid request", content: errorContent },
    401: { description: "Unauthorized", content: errorContent },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/stats",
  tags: ["Stats"],
  summary: "Get aggregated email stats",
  description: "Returns email stats aggregated across providers.\n\n**Without `groupBy`:** returns a flat `StatsResponse` with optional `transactional` and `broadcast` objects.\n\n**With `groupBy`:** returns a `GroupedStatsResponse` — an object with a `groups` array. Each element has a `key` (the value of the groupBy dimension, e.g. a brand UUID when `groupBy=brandId`) and optional `transactional` / `broadcast` stats objects.\n\nUse the `type` parameter to restrict to a single provider (transactional or broadcast).",
  security: [{ apiKey: [] }],
  request: {
    headers: OrgScopedHeadersSchema,
    query: StatsQuerySchema,
  },
  responses: {
    200: {
      description: "Aggregated stats. Shape depends on whether `groupBy` is set — see `StatsResponse` (flat) vs `GroupedStatsResponse` (grouped).",
      content: {
        "application/json": {
          schema: z.union([StatsResponseSchema, GroupedStatsResponseSchema]),
        },
      },
    },
    401: { description: "Unauthorized", content: errorContent },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "get",
  path: "/public/stats",
  tags: ["Stats"],
  summary: "Get aggregated email stats (public, no identity headers required)",
  description: "Same behavior as `GET /orgs/stats` but does not require `x-org-id` or any identity headers. Intended for internal services (e.g. leaderboard) that don't have user context.\n\n**Without `groupBy`:** returns a flat `StatsResponse`.\n\n**With `groupBy`:** returns a `GroupedStatsResponse` — `{ groups: [{ key, transactional?, broadcast? }] }`. The `key` is the value of the groupBy dimension (e.g. a brand UUID when `groupBy=brandId`).",
  security: [{ apiKey: [] }],
  request: {
    query: StatsQuerySchema,
  },
  responses: {
    200: {
      description: "Aggregated stats. Shape depends on whether `groupBy` is set — see `StatsResponse` (flat) vs `GroupedStatsResponse` (grouped).",
      content: {
        "application/json": {
          schema: z.union([StatsResponseSchema, GroupedStatsResponseSchema]),
        },
      },
    },
    401: { description: "Unauthorized", content: errorContent },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/status",
  tags: ["Status"],
  summary: "Get delivery status for emails",
  description: [
    "Batch lookup of delivery status for a list of emails. Requires at least one of `brandId` or `campaignId` in the body.",
    "",
    "**Two modes:**",
    "",
    "| `brandId` | `campaignId` | Mode | Active fields |",
    "|-----------|-------------|------|---------------|",
    "| present | absent | Brand | `byCampaign` + `brand` + `global` |",
    "| absent | present | Campaign | `campaign` + `global` |",
    "| present | present | Campaign | `campaign` + `global` (brandId ignored) |",
    "| absent | absent | — | 400 error |",
    "",
    "**Brand mode** (`brandId` without `campaignId`): returns a `byCampaign` object mapping each campaignId to its `StatusScope`, plus an aggregated `brand` scope (BOOL_OR across campaigns, `replyClassification` from most recent, `lastDeliveredAt` = MAX).",
    "",
    "**Campaign mode** (`campaignId` present): returns a single `campaign` scope for that campaign.",
    "",
    "Non-applicable fields are always present but set to `null`.",
    "",
    "Returns status from both broadcast (Instantly) and transactional (Postmark) providers. If one provider fails, the other's results are still returned. If both fail, returns 502.",
    "",
    "**Headers** (`x-brand-id`, `x-campaign-id`, etc.) are tracing/logging only — they are forwarded to downstream services but do NOT influence filtering logic. Filtering is driven exclusively by body fields.",
  ].join("\n"),
  security: [{ apiKey: [] }],
  request: {
    headers: OrgScopedHeadersSchema,
    body: {
      content: {
        "application/json": {
          schema: StatusRequestSchema,
          examples: {
            campaignMode: {
              summary: "Campaign mode — status for a specific campaign",
              value: {
                campaignId: "b47ac10b-58cc-4372-a567-0e02b2c3d479",
                items: [
                  { email: "alice@media.com" },
                  { email: "bob@press.org" },
                ],
              },
            },
            brandMode: {
              summary: "Brand mode — per-campaign breakdown for a brand",
              value: {
                brandId: "c58bd21c-69dd-4483-b678-1f13c3d4e590",
                items: [
                  { email: "alice@media.com" },
                ],
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "Status results per email, split by provider (broadcast / transactional).",
      content: {
        "application/json": {
          schema: StatusResponseSchema,
          examples: {
            campaignMode: {
              summary: "Campaign mode response",
              value: {
                results: [{
                  email: "alice@media.com",
                  broadcast: {
                    byCampaign: null,
                    campaign: {
                      contacted: true, delivered: true, opened: false, replied: false,
                      replyClassification: null, bounced: false, unsubscribed: false,
                      lastDeliveredAt: "2026-02-20T14:30:00.000Z",
                    },
                    brand: null,
                    global: { email: { bounced: false, unsubscribed: false } },
                  },
                }],
              },
            },
            brandMode: {
              summary: "Brand mode response — byCampaign breakdown + aggregated brand",
              value: {
                results: [{
                  email: "alice@media.com",
                  broadcast: {
                    byCampaign: {
                      "b47ac10b-58cc-4372-a567-0e02b2c3d479": {
                        contacted: true, delivered: true, opened: false, replied: false,
                        replyClassification: null, bounced: false, unsubscribed: false,
                        lastDeliveredAt: "2026-03-01T10:00:00.000Z",
                      },
                      "d69ce32d-7aee-5594-c789-2g24d4e5f6a1": {
                        contacted: true, delivered: true, opened: true, replied: true,
                        replyClassification: "positive", bounced: false, unsubscribed: false,
                        lastDeliveredAt: "2026-03-02T12:00:00.000Z",
                      },
                    },
                    campaign: null,
                    brand: {
                      contacted: true, delivered: true, opened: true, replied: true,
                      replyClassification: "positive", bounced: false, unsubscribed: false,
                      lastDeliveredAt: "2026-03-02T12:00:00.000Z",
                    },
                    global: { email: { bounced: false, unsubscribed: false } },
                  },
                }],
              },
            },
          },
        },
      },
    },
    400: { description: "Invalid request — missing brandId and campaignId, empty items, or invalid email", content: errorContent },
    401: { description: "Unauthorized — missing or invalid X-API-Key", content: errorContent },
    502: { description: "Upstream service error — both providers failed", content: errorContent },
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
