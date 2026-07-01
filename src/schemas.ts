// Side-effect import — extends Zod with `.openapi()` so subsequent local schema
// declarations (`z.object({...}).openapi("Name")`) work. Imported contract
// schemas are re-exported as-is without `.openapi(name)`: zod-to-openapi v8's
// `.openapi(name)` requires the schema instance to be created AFTER the
// extension (Zod 4 attaches prototype methods at construction time). The
// OpenAPI generator inlines contract shapes where they're referenced; trade-off
// accepted to keep a single source of truth in the contract package.
import "./zod-setup";

import { z } from "zod";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  ReplyClassificationSchema as RawReplyClassification,
  RepliesDetailSchema as RawRepliesDetail,
  RecipientStatsSchema as RawRecipientStats,
  StepStatsSchema as RawStepStats,
  EmailStatsSchema as RawEmailStats,
  ChannelStatsSchema as RawChannelStats,
  StatusScopeSchema as RawStatusScope,
  GlobalStatusSchema as RawGlobalStatus,
  ProviderStatusSchema as RawProviderStatus,
} from "@shamanic-technologies/email-domain-contract";

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

// --- Shared cross-provider schemas (imported from email-domain-contract) ---
// Re-exported as-is. The OpenAPI generator inlines them where they're referenced
// (no $ref name) because zod-to-openapi v8's `.openapi(name)` cannot be applied
// to pre-existing Zod 4 schema instances without the consumer creating them
// fresh. Trade-off accepted for v1: slightly more verbose OpenAPI output, but
// the schemas remain a single source of truth in the contract package.

export const ReplyClassificationSchema = RawReplyClassification;
export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;

export const RepliesDetailSchema = RawRepliesDetail;
export type RepliesDetail = z.infer<typeof RepliesDetailSchema>;

export const RecipientStatsSchema = RawRecipientStats;
export type RecipientStats = z.infer<typeof RecipientStatsSchema>;

export const StepStatsSchema = RawStepStats;
export type StepStats = z.infer<typeof StepStatsSchema>;

export const EmailStatsSchema = RawEmailStats;
export type EmailStats = z.infer<typeof EmailStatsSchema>;

export const ChannelStatsSchema = RawChannelStats;
export type ChannelStats = z.infer<typeof ChannelStatsSchema>;

export const StatusScopeSchema = RawStatusScope;
export type StatusScope = z.infer<typeof StatusScopeSchema>;

export const GlobalStatusSchema = RawGlobalStatus;
export type GlobalStatus = z.infer<typeof GlobalStatusSchema>;

export const ProviderStatusSchema = RawProviderStatus;
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

// --- Enums (email-gateway-only) ---

export const EmailTypeSchema = z.enum(["transactional", "broadcast"]);
export type EmailType = z.infer<typeof EmailTypeSchema>;

// --- POST /orgs/send ---

const SendBaseSchema = z.object({
  campaignId: z.string().optional().describe("Campaign ID for tracking and stats grouping"),
  leadId: z.string().optional().describe("Lead ID for end-to-end tracking. When provided: logged on receipt, forwarded to the downstream provider (Postmark/Instantly), and returned as `messageId` in the response for broadcast sends. Omitting it means email stats cannot be correlated back to the lead."),
  workflowSlug: z.string().optional().describe("Workflow slug for tracking and grouping"),
  to: z.string({ error: "the lead has no email address" }).email("to must be a valid email address").describe("Recipient email address"),
  recipientFirstName: z.string().optional().describe("Recipient first name"),
  recipientLastName: z.string().optional().describe("Recipient last name"),
  recipientCompany: z.string().optional().describe("Recipient company name"),
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

const messageIdRegex = /^<[^<>\s]+@[^<>\s]+>$/;

const TransactionalSendSchema = SendBaseSchema.extend({
  type: z.literal("transactional").describe("Transactional email channel"),
  subject: z.string().describe("Email subject line"),
  htmlBody: z.string().optional().describe("HTML email body"),
  textBody: z.string().optional().describe("Plain text email body"),
  from: z.string().optional().describe("Sender address, e.g. \"Display Name <email@domain.com>\". If omitted, the downstream provider resolves its own default."),
  bcc: z.string().optional().describe("Blind-carbon-copy recipients as a comma-separated email list. Forwarded to postmark-service, which sets Postmark's Bcc header. Transactional only."),
  inReplyTo: z
    .string()
    .regex(messageIdRegex, "inReplyTo must be a RFC 5322 Message-ID enclosed in angle brackets, e.g. <id@host>")
    .optional()
    .describe("RFC 5322 In-Reply-To header — Message-ID of the email being replied to, including angle brackets"),
  references: z
    .string()
    .optional()
    .describe("RFC 5322 References header — space-separated list of Message-IDs (each enclosed in angle brackets) representing the thread chain"),
  messageStream: z
    .string()
    .optional()
    .describe("Postmark message stream ID. If omitted, postmark-service uses its configured default."),
});

const BroadcastSendSchema = SendBaseSchema.extend({
  type: z.literal("broadcast").describe("Broadcast email channel"),
  subject: z.string().describe("Shared email subject line (same thread, follow-ups are Re:)"),
  sequence: z.array(SequenceStepSchema).min(1).describe("Email sequence steps sent via Instantly"),
  bcc: z.string().optional().describe("Blind-carbon-copy recipients as a comma-separated email list. Split into an array and forwarded to instantly-service, which sets the Instantly campaign's bcc_list so the whole editorial team shares one thread. Absent/empty = no BCC."),
  timezone: z.string().optional().describe("Recipient's IANA timezone (e.g. \"America/New_York\"), sourced from the lead. Forwarded to instantly-service so the cold-email sequence is scheduled in the prospect's local business hours. Absent/invalid = instantly-service falls back to its default timezone."),
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

export const GroupByDimensionSchema = z.enum(["brandId", "campaignId", "workflowSlug", "featureSlug", "recipientEmail", "workflowDynastySlug", "featureDynastySlug", "day"]);
export type GroupByDimension = z.infer<typeof GroupByDimensionSchema>;

export const StatsQuerySchema = z
  .object({
    type: EmailTypeSchema.optional().describe("Filter by email channel type"),
    runIds: z.string().optional().describe("Comma-separated run IDs"),
    brandId: z.string().optional().describe("Comma-separated brand IDs to filter by"),
    campaignId: z.string().optional().describe("Filter by campaign ID"),
    workflowSlugs: z.string().optional().describe("Comma-separated workflow slugs to filter by"),
    featureSlugs: z.string().optional().describe("Comma-separated feature slugs to filter by"),
    workflowDynastySlug: z.string().optional().describe("Filter by workflow dynasty slug (resolved to all versioned slugs)"),
    featureDynastySlug: z.string().optional().describe("Filter by feature dynasty slug (resolved to all versioned slugs)"),
    groupBy: GroupByDimensionSchema.optional().describe("Group results by dimension"),
    timezone: z.string().optional().describe("IANA timezone used by broadcast stats when groupBy=day. Transactional stats do not produce day groups."),
  })
  .openapi("StatsQuery");

export type StatsQuery = z.infer<typeof StatsQuerySchema>;

export const StatsResponseSchema = z
  .object({
    transactional: ChannelStatsSchema.optional().describe("Stats for transactional emails"),
    broadcast: ChannelStatsSchema.optional().describe("Stats for broadcast emails"),
  })
  .openapi("StatsResponse");

export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const StatsGroupSchema = z
  .object({
    key: z.string().describe("The value of the groupBy dimension for this bucket."),
    transactional: ChannelStatsSchema.optional().describe("Transactional (Postmark) stats for this group."),
    broadcast: ChannelStatsSchema.optional().describe("Broadcast (Instantly) stats for this group."),
  })
  .openapi("StatsGroup");

export type StatsGroup = z.infer<typeof StatsGroupSchema>;

export const GroupedStatsResponseSchema = z
  .object({
    groups: z.array(StatsGroupSchema).describe("One entry per unique value of the groupBy dimension."),
  })
  .openapi("GroupedStatsResponse", {
    description: "Returned instead of StatsResponse when the groupBy query parameter is set.",
  });

export type GroupedStatsResponse = z.infer<typeof GroupedStatsResponseSchema>;

export const PublicEngagementLatencyQuerySchema = z
  .object({
    featureSlugs: z.string().describe("Comma-separated feature slugs to filter by"),
    groupBy: z.string().describe("Only workflowSlug is supported"),
  })
  .openapi("PublicEngagementLatencyQuery");

export type PublicEngagementLatencyQuery = z.infer<typeof PublicEngagementLatencyQuerySchema>;

export const EngagementLatencyMetricSchema = z
  .object({
    averageMs: z.number().nullable().describe("Average elapsed time in milliseconds. Null when sampleSize is 0."),
    medianMs: z.number().nullable().describe("Median elapsed time in milliseconds. Null when sampleSize is 0."),
    sampleSize: z.number().int().describe("Number of recipients included in the aggregate."),
  })
  .openapi("EngagementLatencyMetric");

export type EngagementLatencyMetric = z.infer<typeof EngagementLatencyMetricSchema>;

export const PublicEngagementLatencyGroupSchema = z
  .object({
    key: z.string().describe("Workflow slug for this public-safe aggregate group."),
    timeToFirstLinkClick: EngagementLatencyMetricSchema,
    timeToFirstPositiveReply: EngagementLatencyMetricSchema,
  })
  .openapi("PublicEngagementLatencyGroup");

export type PublicEngagementLatencyGroup = z.infer<typeof PublicEngagementLatencyGroupSchema>;

export const PublicEngagementLatencyResponseSchema = z
  .object({
    groups: z.array(PublicEngagementLatencyGroupSchema).describe("One public-safe latency aggregate per workflow slug."),
  })
  .openapi("PublicEngagementLatencyResponse");

export type PublicEngagementLatencyResponse = z.infer<typeof PublicEngagementLatencyResponseSchema>;

// --- GET /public/stats/sending-forecast ---
// Passthrough of instantly-service's fleet sending forecast. Field names mirror
// the provider's response byte-for-byte (features-service depends on the contract).

export const SendingForecastDaySchema = z
  .object({
    date: z.string().describe("Calendar day, YYYY-MM-DD (UTC)."),
    scheduledCount: z.number().int().describe("Emails scheduled to send that day across the whole fleet."),
  })
  .openapi("SendingForecastDay");

export type SendingForecastDay = z.infer<typeof SendingForecastDaySchema>;

export const SendingForecastResponseSchema = z
  .object({
    asOf: z.string().describe("ISO8601 timestamp of computation."),
    dailyCapacity: z.number().int().describe("Emails/day the healthy fleet can send."),
    healthyAccountCount: z.number().int().describe("Accounts passing the provider's health filter."),
    totalAccountCount: z.number().int().describe("All accounts in the shared workspace before filtering."),
    blockedDomainCount: z.number().int().describe("Accounts excluded because their domain is blocked."),
    days: z
      .array(SendingForecastDaySchema)
      .describe("Per-day scheduled send volume from today forward, chronological. May be [] when nothing is scheduled."),
  })
  .openapi("SendingForecastResponse");

export type SendingForecastResponse = z.infer<typeof SendingForecastResponseSchema>;

// --- POST /orgs/status ---

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
    brandId: z.string().optional().describe("Brand ID — if present without campaignId, activates brand mode: returns per-campaign breakdown (byCampaign) + aggregated brand status. If both brandId and campaignId are provided, campaign mode takes precedence and brandId is ignored. Omit both brandId and campaignId for org mode (global signals only)."),
    campaignId: z.string().optional().describe("Campaign ID — if present, activates campaign mode: returns status scoped to this specific campaign. Takes precedence over brandId. Omit both brandId and campaignId for org mode (global signals only)."),
    items: z.array(StatusItemSchema).min(1).describe("List of emails to check status for"),
  })
  .openapi("StatusRequest");

export type StatusRequest = z.infer<typeof StatusRequestSchema>;

export const StatusResponseSchema = z
  .object({
    results: z.array(StatusResultSchema).describe("Status results per item"),
  })
  .openapi("StatusResponse");

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// --- POST /orgs/manual-qualifications ---

export const ManualQualificationStatusSchema = z
  .enum([
    "lead_interested",
    "lead_meeting_booked",
    "lead_closed",
    "lead_not_interested",
    "lead_wrong_person",
    "lead_neutral",
    "lead_out_of_office",
    "auto_reply_received",
  ])
  .openapi("ManualQualificationStatus", {
    description:
      "Manual reply qualification status — mirrors Instantly webhook reply event_type values exactly. Set by a human via the dashboard when Instantly fails to detect a reply (e.g. reply received on a non-leurre email account).",
  });

export type ManualQualificationStatus = z.infer<typeof ManualQualificationStatusSchema>;

export const ManualQualificationSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    campaignId: z.string(),
    instantlyCampaignId: z.string(),
    email: z.string(),
    status: ManualQualificationStatusSchema,
    qualifiedBy: z.string(),
    notes: z.string().nullable(),
    qualifiedAt: z.string().describe("ISO 8601 timestamp"),
  })
  .openapi("ManualQualification");

export type ManualQualification = z.infer<typeof ManualQualificationSchema>;

export const PostManualQualificationRequestSchema = z
  .object({
    campaign_id: z
      .string()
      .min(1)
      .describe("Logical campaign id (groups sub-campaigns for the same workflow run)"),
    email: z.string().email().describe("Lead email address"),
    status: ManualQualificationStatusSchema,
    notes: z.string().max(2000).optional().describe("Optional free-text human note for audit"),
  })
  .openapi("PostManualQualificationRequest");

export type PostManualQualificationRequest = z.infer<typeof PostManualQualificationRequestSchema>;

export const PostManualQualificationResponseSchema = z
  .object({
    idempotent: z
      .boolean()
      .describe(
        "True if the latest existing row already matched the requested status — no new bronze row was inserted, no side effects fired",
      ),
    qualification: ManualQualificationSchema,
  })
  .openapi("PostManualQualificationResponse");

export type PostManualQualificationResponse = z.infer<typeof PostManualQualificationResponseSchema>;

export const GetManualQualificationsQuerySchema = z
  .object({
    campaign_id: z.string().min(1).optional().describe("Filter by logical campaign id"),
    email: z.string().email().optional().describe("Filter by lead email"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Max rows to return (default 200, max 500)"),
  })
  .openapi("GetManualQualificationsQuery");

export type GetManualQualificationsQuery = z.infer<typeof GetManualQualificationsQuerySchema>;

export const GetManualQualificationsResponseSchema = z
  .object({
    qualifications: z.array(ManualQualificationSchema),
  })
  .openapi("GetManualQualificationsResponse");

export type GetManualQualificationsResponse = z.infer<typeof GetManualQualificationsResponseSchema>;

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
  description: "Send a transactional or broadcast email via the appropriate provider. Routes to Postmark (transactional) or Instantly (broadcast) based on `type`.",
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
                timezone: "America/New_York",
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
  description: "Returns email stats aggregated across providers.\n\n**Without `groupBy`:** returns a flat `StatsResponse` with optional `transactional` and `broadcast` objects.\n\n**With `groupBy`:** returns a `GroupedStatsResponse` — an object with a `groups` array. Each element has a `key` (the value of the groupBy dimension, e.g. a brand UUID when `groupBy=brandId`) and optional `transactional` / `broadcast` stats objects.\n\n`groupBy=day` is broadcast-only and delegates local-calendar grouping to instantly-service; pass `timezone` as an IANA timezone when needed. Transactional stats do not produce day groups, so day groups contain only `broadcast` data.\n\nUse the `type` parameter to restrict to a single provider (transactional or broadcast).",
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
  description: "Same behavior as `GET /orgs/stats` but does not require `x-org-id` or any identity headers. Intended for internal services (e.g. leaderboard) that don't have user context.\n\n**Without `groupBy`:** returns a flat `StatsResponse`.\n\n**With `groupBy`:** returns a `GroupedStatsResponse` — `{ groups: [{ key, transactional?, broadcast? }] }`. The `key` is the value of the groupBy dimension (e.g. a brand UUID when `groupBy=brandId`). `groupBy=day` is broadcast-only, accepts optional IANA `timezone`, and returns groups with only `broadcast` populated.",
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
  method: "get",
  path: "/public/stats/engagement-latency",
  tags: ["Stats"],
  summary: "Get public-safe engagement latency by workflow slug",
  description:
    "Returns public-safe sales outreach engagement latency aggregates grouped by workflow slug for the supplied feature slugs. " +
    "The gateway delegates average/median timing math to the broadcast provider's dated email event aggregate and returns only averageMs, medianMs, and sampleSize. " +
    "No lead emails, recipient IDs, campaign IDs or names, org details, message bodies, or message internals are exposed. Only `groupBy=workflowSlug` is supported.",
  security: [{ apiKey: [] }],
  request: {
    query: PublicEngagementLatencyQuerySchema,
  },
  responses: {
    200: {
      description: "Public-safe engagement latency aggregates by workflow slug.",
      content: {
        "application/json": {
          schema: PublicEngagementLatencyResponseSchema,
        },
      },
    },
    400: { description: "Invalid request or unsupported grouping", content: errorContent },
    401: { description: "Unauthorized", content: errorContent },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "get",
  path: "/public/stats/sending-forecast",
  tags: ["Stats"],
  summary: "Get the fleet sending forecast (public, provider-agnostic)",
  description:
    "Relays the broadcast provider's fleet sending forecast: the available daily sending CAPACITY (`dailyCapacity`) alongside a per-day projection of upcoming scheduled send VOLUME (`days[]`, chronological, each `{ date, scheduledCount }`). " +
    "Fleet-wide (no org filter) — a global forecast; requires no identity headers. " +
    "Passthrough: field names are preserved exactly as the provider returns them. " +
    "Fails loud (502) on any provider error or missing config; no silent zero fallback.",
  security: [{ apiKey: [] }],
  responses: {
    200: {
      description: "Fleet sending forecast — daily capacity and per-day scheduled volume.",
      content: {
        "application/json": {
          schema: SendingForecastResponseSchema,
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
    "Batch lookup of delivery status for a list of emails. `brandId` and `campaignId` are both optional — pass either, both, or neither.",
    "",
    "**Three modes:**",
    "",
    "| `brandId` | `campaignId` | Mode | Active fields |",
    "|-----------|-------------|------|---------------|",
    "| present | absent | Brand | `byCampaign` + `brand` + `global` |",
    "| absent | present | Campaign | `campaign` + `global` |",
    "| present | present | Campaign | `campaign` + `global` (brandId ignored) |",
    "| absent | absent | Org | `global` only |",
    "",
    "**Brand mode** (`brandId` without `campaignId`): returns a `byCampaign` object mapping each campaignId to its `StatusScope`, plus an aggregated `brand` scope (BOOL_OR across campaigns, `replyClassification` from most recent, `lastDeliveredAt` = MAX).",
    "",
    "**Campaign mode** (`campaignId` present): returns a single `campaign` scope for that campaign.",
    "",
    "**Org mode** (neither `brandId` nor `campaignId`): returns only the `global` block — org-wide bounce/unsubscribe signals. Useful for cross-brand, cross-campaign delivery checks (e.g. dashboards aggregating across all brands of an org).",
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
            orgMode: {
              summary: "Org mode — global signals only (no brandId, no campaignId)",
              value: {
                items: [
                  { email: "alice@media.com" },
                  { email: "bob@press.org" },
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
                      contacted: true, sent: true, delivered: true, opened: true, clicked: true, replied: false,
                      replyClassification: null, bounced: false, unsubscribed: false,
                      lastDeliveredAt: "2026-02-20T14:30:00.000Z",
                      firstContactedAt: "2026-02-20T14:29:00.000Z",
                      firstSentAt: "2026-02-20T14:29:30.000Z",
                      firstDeliveredAt: "2026-02-20T14:30:00.000Z",
                      firstOpenedAt: "2026-02-21T09:15:00.000Z",
                      firstClickedAt: "2026-02-22T11:40:00.000Z",
                      firstRepliedAt: null,
                      firstBouncedAt: null,
                      firstUnsubscribedAt: null,
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
                        contacted: true, sent: true, delivered: true, opened: false, clicked: false, replied: false,
                        replyClassification: null, bounced: false, unsubscribed: false,
                        lastDeliveredAt: "2026-03-01T10:00:00.000Z",
                        firstContactedAt: "2026-03-01T09:59:00.000Z",
                        firstSentAt: "2026-03-01T09:59:30.000Z",
                        firstDeliveredAt: "2026-03-01T10:00:00.000Z",
                        firstOpenedAt: null, firstClickedAt: null, firstRepliedAt: null,
                        firstBouncedAt: null, firstUnsubscribedAt: null,
                      },
                      "d69ce32d-7aee-5594-c789-2g24d4e5f6a1": {
                        contacted: true, sent: true, delivered: true, opened: true, clicked: true, replied: true,
                        replyClassification: "positive", bounced: false, unsubscribed: false,
                        lastDeliveredAt: "2026-03-02T12:00:00.000Z",
                        firstContactedAt: "2026-03-02T11:59:00.000Z",
                        firstSentAt: "2026-03-02T11:59:30.000Z",
                        firstDeliveredAt: "2026-03-02T12:00:00.000Z",
                        firstOpenedAt: "2026-03-02T13:10:00.000Z",
                        firstClickedAt: "2026-03-02T15:45:00.000Z",
                        firstRepliedAt: "2026-03-03T08:20:00.000Z",
                        firstBouncedAt: null, firstUnsubscribedAt: null,
                      },
                    },
                    campaign: null,
                    brand: {
                      contacted: true, sent: true, delivered: true, opened: true, clicked: true, replied: true,
                      replyClassification: "positive", bounced: false, unsubscribed: false,
                      lastDeliveredAt: "2026-03-02T12:00:00.000Z",
                      // brand scope = MIN across the brand's campaigns (first occurrence anywhere)
                      firstContactedAt: "2026-03-01T09:59:00.000Z",
                      firstSentAt: "2026-03-01T09:59:30.000Z",
                      firstDeliveredAt: "2026-03-01T10:00:00.000Z",
                      firstOpenedAt: "2026-03-02T13:10:00.000Z",
                      firstClickedAt: "2026-03-02T15:45:00.000Z",
                      firstRepliedAt: "2026-03-03T08:20:00.000Z",
                      firstBouncedAt: null, firstUnsubscribedAt: null,
                    },
                    global: { email: { bounced: false, unsubscribed: false } },
                  },
                }],
              },
            },
            orgMode: {
              summary: "Org mode response — only global signals populated",
              value: {
                results: [{
                  email: "alice@media.com",
                  broadcast: {
                    byCampaign: null,
                    campaign: null,
                    brand: null,
                    global: { email: { bounced: false, unsubscribed: false } },
                  },
                  transactional: {
                    byCampaign: null,
                    campaign: null,
                    brand: null,
                    global: { email: { bounced: false, unsubscribed: false } },
                  },
                }],
              },
            },
          },
        },
      },
    },
    400: { description: "Invalid request — empty items or invalid email", content: errorContent },
    401: { description: "Unauthorized — missing or invalid X-API-Key", content: errorContent },
    502: { description: "Upstream service error — both providers failed", content: errorContent },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/manual-qualifications",
  tags: ["Manual Qualifications"],
  summary: "Set a manual reply qualification for a (campaign, lead) pair",
  description: [
    "Proxy to instantly-service `POST /orgs/manual-qualifications`. Records a human-set reply classification for a lead in a campaign — used when Instantly's automatic webhook reply classification fails to detect a reply (e.g. the reply was sent to a non-leurre account).",
    "",
    "The gateway validates the body locally and forwards it byte-identical to instantly-service. Identity headers (`x-org-id`, `x-user-id`, `x-run-id`, etc.) are propagated. Upstream 4xx responses are round-tripped to the caller byte-equal; network failures and upstream 5xx surface as 502.",
  ].join("\n"),
  security: [{ apiKey: [] }],
  request: {
    headers: OrgScopedHeadersSchema,
    body: {
      content: {
        "application/json": {
          schema: PostManualQualificationRequestSchema,
          examples: {
            interested: {
              summary: "Mark a lead as interested after a manual reply check",
              value: {
                campaign_id: "c1a2b3c4-0000-0000-0000-000000000001",
                email: "alice@media.com",
                status: "lead_interested",
                notes: "Reply received on Gmail — Instantly missed it",
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "Manual qualification recorded (or idempotent no-op)",
      content: { "application/json": { schema: PostManualQualificationResponseSchema } },
    },
    400: { description: "Invalid body or missing identity header", content: errorContent },
    401: { description: "Unauthorized", content: errorContent },
    404: { description: "Campaign not found in this org for the given email", content: errorContent },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/manual-qualifications",
  tags: ["Manual Qualifications"],
  summary: "List manual reply qualifications (org-scoped audit history)",
  description:
    "Proxy to instantly-service `GET /orgs/manual-qualifications`. Returns the org's manual qualification history, sorted by `qualifiedAt` DESC. Optionally filter by `campaign_id` and/or `email`. Cross-org reads are blocked by instantly-service.",
  security: [{ apiKey: [] }],
  request: {
    headers: OrgScopedHeadersSchema,
    query: GetManualQualificationsQuerySchema,
  },
  responses: {
    200: {
      description: "List of manual qualifications",
      content: { "application/json": { schema: GetManualQualificationsResponseSchema } },
    },
    400: { description: "Invalid query parameters", content: errorContent },
    401: { description: "Unauthorized", content: errorContent },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "post",
  path: "/webhooks/postmark",
  tags: ["Webhooks"],
  summary: "Forward Postmark webhook events to upstream postmark-service",
  description: "Legacy passthrough. Forwards the body to the upstream postmark-service. Inbound (`RecordType=Inbound`) routing now happens via `POST /inbound/postmark` after postmark-service handles Postmark webhooks directly.",
  responses: {
    200: { description: "Webhook forwarded" },
    502: { description: "Upstream service error", content: errorContent },
  },
});

registry.registerPath({
  method: "post",
  path: "/inbound/postmark",
  tags: ["Inbound"],
  summary: "Receive Postmark inbound payload from postmark-service and fan out to subscribers",
  description: [
    "Internal service-to-service endpoint. Called by postmark-service when Postmark delivers an inbound email (`RecordType=Inbound`). The body is the raw Postmark inbound payload, untransformed.",
    "",
    "**Fan-out:** matches the payload's recipients against `EMAIL_GATEWAY_SUBSCRIPTIONS` (env JSON). Every matching subscription receives a signed HTTP POST to its `endpoint_url`.",
    "",
    "**Headers sent to each subscriber:**",
    "- `content-type: application/json`",
    "- `x-eg-signature: t=<unix>,v1=<hex sha256(t.body, secret)>` — HMAC-SHA256 over `${unix_seconds}.${body}` with the subscription's shared secret",
    "- `idempotency-key: <Postmark MessageID>` — consumer must dedupe on this",
    "",
    "**Fail loud:** if any subscriber returns non-2xx or the network call errors, this endpoint returns 502. The caller (postmark-service) propagates the 5xx to Postmark, whose 45-minute retry window then re-delivers the event.",
    "",
    "**Auth:** `x-api-key` (shared service key, same one used across internal services).",
  ].join("\n"),
  security: [{ apiKey: [] }],
  responses: {
    200: { description: "Inbound payload dispatched to all matching subscribers (or no subscriber matched)" },
    401: { description: "Unauthorized", content: errorContent },
    500: { description: "Internal error (e.g. missing MessageID)", content: errorContent },
    502: { description: "Subscriber delivery failed", content: errorContent },
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
