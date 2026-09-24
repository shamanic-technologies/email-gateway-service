import { Router, Request, Response } from "express";
import { z } from "zod";
import { StatsQuerySchema, OperationStatsQuerySchema, PublicEngagementLatencyQuerySchema, ChannelStats, RecipientStats, EmailStats, RepliesDetail } from "../schemas";
import type { OrgContext } from "../middleware/requireOrgId";
import { extractOrgContext } from "../middleware/requireOrgId";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import * as dynastyClient from "../lib/dynasty-client";
import type {
  ProviderStatsFlat,
  ProviderStatsGrouped,
  ProviderStatsResult,
} from "../lib/instantly-client";

const router = Router();
const internalRouter = Router();

const ZERO_DETAIL: RepliesDetail = { interested: 0, meetingBooked: 0, closed: 0, notInterested: 0, wrongPerson: 0, unsubscribe: 0, neutral: 0, autoReply: 0, outOfOffice: 0 };

const ZERO_RECIPIENT_STATS: RecipientStats = {
  contacted: 0, sent: 0, delivered: 0, opened: 0, bounced: 0, clicked: 0, unsubscribed: 0,
  repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0,
  repliesDetail: ZERO_DETAIL,
};

const ZERO_EMAIL_STATS: EmailStats = {
  sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0,
};

const ZERO_CHANNEL_STATS: ChannelStats = {
  recipientStats: ZERO_RECIPIENT_STATS,
  emailStats: ZERO_EMAIL_STATS,
};

function toChannelStats(raw: ProviderStatsFlat): ChannelStats {
  return { recipientStats: raw.recipientStats, emailStats: raw.emailStats };
}

function isGrouped(result: ProviderStatsResult): result is ProviderStatsGrouped {
  return "groups" in result;
}

function addDetail(a: RepliesDetail, b: RepliesDetail): RepliesDetail {
  return {
    interested: a.interested + b.interested,
    meetingBooked: a.meetingBooked + b.meetingBooked,
    closed: a.closed + b.closed,
    notInterested: a.notInterested + b.notInterested,
    wrongPerson: a.wrongPerson + b.wrongPerson,
    unsubscribe: a.unsubscribe + b.unsubscribe,
    neutral: a.neutral + b.neutral,
    autoReply: a.autoReply + b.autoReply,
    outOfOffice: a.outOfOffice + b.outOfOffice,
  };
}

function addRecipientStats(a: RecipientStats, b: RecipientStats): RecipientStats {
  return {
    contacted: a.contacted + b.contacted,
    sent: a.sent + b.sent,
    delivered: a.delivered + b.delivered,
    opened: a.opened + b.opened,
    bounced: a.bounced + b.bounced,
    clicked: a.clicked + b.clicked,
    unsubscribed: a.unsubscribed + b.unsubscribed,
    repliesPositive: a.repliesPositive + b.repliesPositive,
    repliesNegative: a.repliesNegative + b.repliesNegative,
    repliesNeutral: a.repliesNeutral + b.repliesNeutral,
    repliesAutoReply: a.repliesAutoReply + b.repliesAutoReply,
    repliesDetail: addDetail(a.repliesDetail, b.repliesDetail),
  };
}

function addEmailStats(a: EmailStats, b: EmailStats): EmailStats {
  return {
    sent: a.sent + b.sent,
    delivered: a.delivered + b.delivered,
    opened: a.opened + b.opened,
    clicked: a.clicked + b.clicked,
    bounced: a.bounced + b.bounced,
    unsubscribed: a.unsubscribed + b.unsubscribed,
  };
}

function addChannelStats(a: ChannelStats, b: ChannelStats): ChannelStats {
  return {
    recipientStats: addRecipientStats(a.recipientStats, b.recipientStats),
    emailStats: addEmailStats(a.emailStats, b.emailStats),
  };
}

function parseStatsInput(req: Request): { success: true; type?: string; filters: Record<string, unknown> } | { success: false; error: unknown } {
  const parsed = StatsQuerySchema.safeParse(req.query);
  if (!parsed.success) return { success: false, error: z.flattenError(parsed.error) };
  const { type, runIds, workflowSlugs, featureSlugs, ...rest } = parsed.data;
  const filters: Record<string, unknown> = { ...rest };
  if (runIds) filters.runIds = runIds.split(",").map((s) => s.trim());
  if (workflowSlugs) filters.workflowSlugs = workflowSlugs.split(",").map((s) => s.trim()).join(",");
  if (featureSlugs) filters.featureSlugs = featureSlugs.split(",").map((s) => s.trim()).join(",");
  return { success: true, type, filters };
}

function parseCommaSeparatedSlugs(raw: string): string[] {
  return Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)));
}

function parsePublicEngagementLatencyInput(req: Request):
  | { success: true; featureSlugs: string[] }
  | { success: false; status: number; error: string; details?: unknown } {
  const parsed = PublicEngagementLatencyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return { success: false, status: 400, error: "Invalid request", details: z.flattenError(parsed.error) };
  }

  if (parsed.data.groupBy !== "workflowSlug") {
    return {
      success: false,
      status: 400,
      error: "Unsupported groupBy",
      details: "Only groupBy=workflowSlug is supported",
    };
  }

  const featureSlugs = parseCommaSeparatedSlugs(parsed.data.featureSlugs);
  if (featureSlugs.length === 0) {
    return {
      success: false,
      status: 400,
      error: "Invalid request",
      details: "featureSlugs must include at least one slug",
    };
  }

  return { success: true, featureSlugs };
}

/** Resolve dynasty slugs into versioned slug arrays and rewrite filters for downstream providers */
async function resolveDynastyFilters(filters: Record<string, unknown>, ctx?: OrgContext): Promise<Record<string, unknown>> {
  const resolved = { ...filters };

  // workflowDynastySlug → resolve to workflowSlugs
  const workflowDynastySlug = resolved.workflowDynastySlug as string | undefined;
  if (workflowDynastySlug) {
    const identityHeaders = ctx?.userId && ctx?.runId ? { orgId: ctx.orgId, userId: ctx.userId, runId: ctx.runId } : undefined;
    const slugs = await dynastyClient.resolveWorkflowDynastySlugs(workflowDynastySlug, identityHeaders);
    if (slugs.length === 0) return { __empty: true };
    resolved.workflowSlugs = slugs.join(",");
    delete resolved.workflowDynastySlug;
  }

  // featureDynastySlug → resolve to featureSlugs
  const featureDynastySlug = resolved.featureDynastySlug as string | undefined;
  if (featureDynastySlug) {
    const identityHeaders = ctx?.userId && ctx?.runId ? { orgId: ctx.orgId, userId: ctx.userId, runId: ctx.runId } : undefined;
    const slugs = await dynastyClient.resolveFeatureDynastySlugs(featureDynastySlug, identityHeaders);
    if (slugs.length === 0) return { __empty: true };
    resolved.featureSlugs = slugs.join(",");
    delete resolved.featureDynastySlug;
  }

  return resolved;
}

/** For dynasty groupBy, we need to query by the underlying slug and then re-group */
function isDynastyGroupBy(groupBy: unknown): groupBy is "workflowDynastySlug" | "featureDynastySlug" {
  return groupBy === "workflowDynastySlug" || groupBy === "featureDynastySlug";
}

function rewriteGroupByForProvider(groupBy: string): string {
  if (groupBy === "workflowDynastySlug") return "workflowSlug";
  if (groupBy === "featureDynastySlug") return "featureSlug";
  return groupBy;
}

// Grouping dimensions that only broadcast (Instantly) can produce. Postmark
// (transactional) has no audience attribution and no local-calendar day grouping,
// so these groupBys are routed to a broadcast-only handler.
function isBroadcastOnlyGroupBy(filters: Record<string, unknown>): boolean {
  return filters.groupBy === "day" || filters.groupBy === "audienceId";
}

function withoutBroadcastOnlyFilters(filters: Record<string, unknown>): Record<string, unknown> {
  // timezone (day-bucketing) and audienceId (audience attribution) are
  // broadcast-only — strip them before hitting postmark.
  const { timezone, audienceId, ...rest } = filters;
  return rest;
}

function regroupByDynasty(
  groups: ProviderStatsGrouped["groups"],
  slugToDynastyMap: Map<string, string>,
): Array<{ key: string; channelStats: ChannelStats }> {
  const dynastyGroups = new Map<string, ChannelStats>();
  for (const g of groups) {
    const dynastyKey = slugToDynastyMap.get(g.key) ?? g.key;
    const stats: ChannelStats = { recipientStats: g.recipientStats, emailStats: g.emailStats };
    const existing = dynastyGroups.get(dynastyKey) ?? { ...ZERO_CHANNEL_STATS };
    dynastyGroups.set(dynastyKey, addChannelStats(existing, stats));
  }
  return Array.from(dynastyGroups.entries()).map(([key, channelStats]) => ({ key, channelStats }));
}

/** Extract a partial OrgContext for public routes where x-org-id may be absent */
function extractPartialContext(req: Request): OrgContext | undefined {
  // Check if any identity/tracking headers are present
  const orgId = typeof req.headers["x-org-id"] === "string" ? req.headers["x-org-id"] : undefined;
  const userId = typeof req.headers["x-user-id"] === "string" ? req.headers["x-user-id"] : undefined;
  const runId = typeof req.headers["x-run-id"] === "string" ? req.headers["x-run-id"] : undefined;
  const campaignId = typeof req.headers["x-campaign-id"] === "string" ? req.headers["x-campaign-id"] : undefined;
  const brandId = typeof req.headers["x-brand-id"] === "string" ? req.headers["x-brand-id"] : undefined;
  const workflowSlug = typeof req.headers["x-workflow-slug"] === "string" ? req.headers["x-workflow-slug"] : undefined;
  const featureSlug = typeof req.headers["x-feature-slug"] === "string" ? req.headers["x-feature-slug"] : undefined;

  const hasAny = orgId || userId || runId || campaignId || brandId || workflowSlug || featureSlug;
  if (!hasAny) return undefined;

  return {
    orgId: orgId ?? "",
    userId,
    runId,
    campaignId,
    brandId,
    workflowSlug,
    featureSlug,
  };
}

async function statsHandler(req: Request, res: Response) {
  const input = parseStatsInput(req);
  if (!input.success) {
    res.status(400).json({ error: "Invalid request", details: input.error });
    return;
  }

  // For org-scoped routes, ctx comes from middleware. For public routes, try to extract from headers.
  const ctx: OrgContext | undefined = res.locals.orgContext ?? extractOrgContext(req) ?? extractPartialContext(req);
  const { type } = input;

  try {
    // Resolve dynasty filters
    const resolvedFilters = await resolveDynastyFilters(input.filters, ctx);

    // If dynasty slug resolved to empty → return zero stats immediately
    if (resolvedFilters.__empty) {
      if (input.filters.groupBy) {
        res.json({ groups: [] });
      } else {
        const response: Record<string, unknown> = {};
        if (!type || type === "transactional") response.transactional = { ...ZERO_CHANNEL_STATS };
        if (!type || type === "broadcast") response.broadcast = { ...ZERO_CHANNEL_STATS };
        res.json(response);
      }
      return;
    }

    const filters: Record<string, unknown> = { ...resolvedFilters, ...(ctx?.orgId && { orgId: ctx.orgId }), ...(ctx?.userId && { userId: ctx.userId }) };

    if (filters.groupBy) {
      if (isDynastyGroupBy(input.filters.groupBy)) {
        return await handleDynastyGrouped(res, type, filters, input.filters.groupBy as "workflowDynastySlug" | "featureDynastySlug", ctx);
      }
      return await handleGrouped(res, type, filters, ctx);
    }

    return await handleFlat(res, type, filters, ctx);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Stats failed: ${message}`);
    res.status(502).json({ error: "Failed to fetch stats", details: message });
  }
}

router.get("/stats", statsHandler);
router.get("/stats/by-operation", operationStatsHandler);
internalRouter.get("/stats", statsHandler);
internalRouter.get("/stats/by-operation", operationStatsHandler);
internalRouter.get("/stats/engagement-latency", publicEngagementLatencyHandler);
internalRouter.get("/stats/sending-forecast", sendingForecastHandler);

/**
 * Aggregate outcomes for one logical send operation.
 *
 * A caller that sent many messages as one operation cannot ask `/stats` for
 * them: the only per-operation filter there is `runIds`, and the run recorded
 * against a message downstream is a CHILD run minted per send — so the caller's
 * own run matches nothing there and the answer is a clean, well-formed zero.
 * The handle here is that same caller run (`operationRunId`), which the
 * transactional provider persists as each message's PARENT run. That is
 * the failure this read removes, and removing it means REFUSING to answer in
 * the same shape: an operation nothing belongs to comes back `matched: false`
 * with no `transactional` block at all, so a blind question cannot be read as a
 * healthy one.
 *
 * Transactional only, and deliberately so. Broadcast sequences are already
 * named by the campaign and audience they belong to, and the broadcast provider
 * has no equivalent per-send handle — answering a broadcast question here would
 * mean inventing one or serving a silent zero, which is what we are fixing.
 *
 * Passthrough of postmark-service's own per-operation read: one indexed query
 * on its side whatever the operation's size, and no fan-out on ours.
 */
async function operationStatsHandler(req: Request, res: Response) {
  const parsed = OperationStatsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: z.flattenError(parsed.error) });
    return;
  }

  const { operationRunId } = parsed.data;
  const ctx: OrgContext | undefined = res.locals.orgContext ?? extractOrgContext(req) ?? extractPartialContext(req);

  try {
    const raw = await postmarkClient.getOperationStats(operationRunId, ctx);

    if (raw === null) {
      // The provider NAMED the empty case (404 + OPERATION_NOT_FOUND). Anything
      // else it fails on — including a bare 404 from a route that no longer
      // exists — throws below and surfaces as a 502, never as an empty match.
      res.json({ operationRunId, matched: false, messagesMatched: 0 });
      return;
    }

    if (!raw.recipientStats || !raw.emailStats) {
      // The provider said it matched and then served no figures. That is a
      // broken contract, not an empty operation — surface it rather than
      // flattening it into the zeros this endpoint exists to never emit.
      throw new Error("postmark-service reported a matched operation with no stats");
    }

    res.json({
      operationRunId,
      matched: true,
      messagesMatched: raw.messagesMatched,
      recipientsMatched: raw.recipientsMatched,
      firstMessageAt: raw.firstMessageAt,
      lastMessageAt: raw.lastMessageAt,
      transactional: { recipientStats: raw.recipientStats, emailStats: raw.emailStats },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Operation stats failed: ${message}`);
    res.status(502).json({ error: "Failed to fetch operation stats", details: message });
  }
}

async function sendingForecastHandler(_req: Request, res: Response) {
  try {
    // Passthrough — relay instantly-service's fleet forecast body as-is
    // (dailyCapacity + days[] with identical field names). No reshape, no
    // zero fallback: any provider error propagates as 5xx.
    const forecast = await instantlyClient.getSendingForecast();
    res.json(forecast);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Sending forecast failed: ${message}`);
    res.status(502).json({ error: "Failed to fetch sending forecast", details: message });
  }
}

async function publicEngagementLatencyHandler(req: Request, res: Response) {
  const input = parsePublicEngagementLatencyInput(req);
  if (!input.success) {
    res.status(input.status).json(input.details === undefined ? { error: input.error } : { error: input.error, details: input.details });
    return;
  }

  try {
    const groupedStats = await instantlyClient.getStats({
      featureSlugs: input.featureSlugs.join(","),
      groupBy: "workflowSlug",
    });

    if (!isGrouped(groupedStats)) {
      throw new Error("instantly-service public stats did not return grouped workflowSlug stats");
    }

    const workflowSlugs = Array.from(new Set(groupedStats.groups.map((group) => group.key).filter(Boolean)));
    if (workflowSlugs.length === 0) {
      res.json({ groups: [] });
      return;
    }

    const groups = Object.fromEntries(
      workflowSlugs.map((workflowSlug) => [workflowSlug, { workflowSlugs: [workflowSlug] }]),
    );
    const latency = await instantlyClient.getPublicEngagementLatencyGroups(groups);

    res.json({
      groups: latency.groups.map((group) => ({
        key: group.key,
        timeToFirstLinkClick: group.timeToFirstLinkClick,
        timeToFirstPositiveReply: group.timeToFirstPositiveReply,
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Public engagement latency failed: ${message}`);
    res.status(502).json({ error: "Failed to fetch engagement latency", details: message });
  }
}

async function handleFlat(
  res: Response,
  type: string | undefined,
  filters: Record<string, unknown>,
  ctx?: OrgContext,
) {
  if (type === "transactional") {
    const raw = await postmarkClient.getStats(withoutBroadcastOnlyFilters(filters) as Parameters<typeof postmarkClient.getStats>[0], ctx);
    res.json({ transactional: toChannelStats(raw as ProviderStatsFlat) });
    return;
  }

  if (type === "broadcast") {
    const raw = await instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx);
    res.json({ broadcast: toChannelStats(raw as ProviderStatsFlat) });
    return;
  }

  // No type specified: aggregate both. Both are required — a provider that
  // fails rejects the whole read (502 via statsHandler), never a 200 with one
  // channel missing, which a consumer summing channels reads as a real drop.
  const [postmarkRaw, instantlyRaw] = await Promise.all([
    postmarkClient.getStats(withoutBroadcastOnlyFilters(filters) as Parameters<typeof postmarkClient.getStats>[0], ctx),
    instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx),
  ]);

  res.json({
    transactional: toChannelStats(postmarkRaw as ProviderStatsFlat),
    broadcast: toChannelStats(instantlyRaw as ProviderStatsFlat),
  });
}

async function handleGrouped(
  res: Response,
  type: string | undefined,
  filters: Record<string, unknown>,
  ctx?: OrgContext,
) {
  if (isBroadcastOnlyGroupBy(filters)) {
    return await handleBroadcastOnlyGrouped(res, type, filters, ctx);
  }

  const postmarkFilters = withoutBroadcastOnlyFilters(filters) as Parameters<typeof postmarkClient.getStats>[0];
  const instantlyFilters = filters as Parameters<typeof instantlyClient.getStats>[0];

  if (type === "transactional") {
    const raw = await postmarkClient.getStats(postmarkFilters, ctx);
    if (!isGrouped(raw)) {
      res.json({ groups: [] });
      return;
    }
    const groups = raw.groups.map((g) => ({
      key: g.key,
      transactional: { recipientStats: g.recipientStats, emailStats: g.emailStats } as ChannelStats,
    }));
    res.json({ groups });
    return;
  }

  if (type === "broadcast") {
    const raw = await instantlyClient.getStats(instantlyFilters, ctx);
    if (!isGrouped(raw)) {
      res.json({ groups: [] });
      return;
    }
    const groups = raw.groups.map((g) => ({
      key: g.key,
      broadcast: { recipientStats: g.recipientStats, emailStats: g.emailStats } as ChannelStats,
    }));
    res.json({ groups });
    return;
  }

  // No type: merge groups from both providers by key. A provider failure
  // rejects the whole read (502 via statsHandler) rather than serving the
  // other provider's groups as if they were the full answer.
  const [postmarkRaw, instantlyRaw] = await Promise.all([
    postmarkClient.getStats(postmarkFilters, ctx),
    instantlyClient.getStats(instantlyFilters, ctx),
  ]);
  if (!isGrouped(instantlyRaw)) {
    throw new Error("instantly-service returned a non-grouped response when grouped was expected");
  }

  const merged = new Map<string, { transactional?: ChannelStats; broadcast?: ChannelStats }>();

  if (isGrouped(postmarkRaw)) {
    for (const g of postmarkRaw.groups) {
      merged.set(g.key, { transactional: { recipientStats: g.recipientStats, emailStats: g.emailStats } });
    }
  }

  for (const g of instantlyRaw.groups) {
    const existing = merged.get(g.key) ?? {};
    existing.broadcast = { recipientStats: g.recipientStats, emailStats: g.emailStats };
    merged.set(g.key, existing);
  }

  const groups = Array.from(merged.entries()).map(([key, value]) => ({
    key,
    ...value,
  }));

  res.json({ groups });
}

async function handleBroadcastOnlyGrouped(
  res: Response,
  type: string | undefined,
  filters: Record<string, unknown>,
  ctx?: OrgContext,
) {
  if (type === "transactional") {
    res.json({ groups: [] });
    return;
  }

  const raw = await instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx);
  if (!isGrouped(raw)) {
    res.json({ groups: [] });
    return;
  }

  const groups = raw.groups.map((g) => ({
    key: g.key,
    broadcast: { recipientStats: g.recipientStats, emailStats: g.emailStats } as ChannelStats,
  }));
  res.json({ groups });
}

async function handleDynastyGrouped(
  res: Response,
  type: string | undefined,
  filters: Record<string, unknown>,
  dynastyGroupBy: "workflowDynastySlug" | "featureDynastySlug",
  ctx?: OrgContext,
) {
  // Rewrite groupBy for downstream providers
  const providerGroupBy = rewriteGroupByForProvider(dynastyGroupBy);
  const providerFilters = { ...filters, groupBy: providerGroupBy };
  const postmarkFilters = withoutBroadcastOnlyFilters(providerFilters) as Parameters<typeof postmarkClient.getStats>[0];
  const instantlyFilters = providerFilters as Parameters<typeof instantlyClient.getStats>[0];

  // Fetch the dynasty map
  const fetchDynasties = dynastyGroupBy === "workflowDynastySlug"
    ? dynastyClient.fetchWorkflowDynasties
    : dynastyClient.fetchFeatureDynasties;

  const identityHeaders = ctx?.userId && ctx?.runId ? { orgId: ctx.orgId, userId: ctx.userId, runId: ctx.runId } : undefined;

  if (type === "transactional") {
    const [raw, dynasties] = await Promise.all([
      postmarkClient.getStats(postmarkFilters, ctx),
      fetchDynasties(identityHeaders),
    ]);
    const slugMap = dynastyClient.buildSlugToDynastyMap(dynasties);
    if (!isGrouped(raw)) {
      res.json({ groups: [] });
      return;
    }
    const regrouped = regroupByDynasty(raw.groups, slugMap);
    res.json({ groups: regrouped.map((g) => ({ key: g.key, transactional: g.channelStats })) });
    return;
  }

  if (type === "broadcast") {
    const [raw, dynasties] = await Promise.all([
      instantlyClient.getStats(instantlyFilters, ctx),
      fetchDynasties(identityHeaders),
    ]);
    const slugMap = dynastyClient.buildSlugToDynastyMap(dynasties);
    if (!isGrouped(raw)) {
      res.json({ groups: [] });
      return;
    }
    const regrouped = regroupByDynasty(raw.groups, slugMap);
    res.json({ groups: regrouped.map((g) => ({ key: g.key, broadcast: g.channelStats })) });
    return;
  }

  // No type: merge both providers
  // Both providers are required: a failure rejects the whole read (502 via
  // statsHandler), never a 200 carrying one provider's groups as the total.
  const [postmarkResult, instantlyResult, dynasties] = await Promise.all([
    postmarkClient.getStats(postmarkFilters, ctx),
    instantlyClient.getStats(instantlyFilters, ctx),
    fetchDynasties(identityHeaders),
  ]);
  if (!isGrouped(instantlyResult)) {
    throw new Error("instantly-service returned a non-grouped response when dynasty grouped was expected");
  }

  const slugMap = dynastyClient.buildSlugToDynastyMap(dynasties);
  const merged = new Map<string, { transactional?: ChannelStats; broadcast?: ChannelStats }>();

  if (isGrouped(postmarkResult)) {
    const regrouped = regroupByDynasty(postmarkResult.groups, slugMap);
    for (const g of regrouped) {
      merged.set(g.key, { transactional: g.channelStats });
    }
  }

  for (const g of regroupByDynasty(instantlyResult.groups, slugMap)) {
    const existing = merged.get(g.key) ?? {};
    existing.broadcast = g.channelStats;
    merged.set(g.key, existing);
  }

  const groups = Array.from(merged.entries()).map(([key, value]) => ({
    key,
    ...value,
  }));

  res.json({ groups });
}

export default router;
export { internalRouter as publicStatsRouter };
