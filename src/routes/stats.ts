import { Router, Request, Response } from "express";
import { z } from "zod";
import { StatsQuerySchema, ChannelStats, RecipientStats, EmailStats, RepliesDetail } from "../schemas";
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
internalRouter.get("/stats", statsHandler);

async function handleFlat(
  res: Response,
  type: string | undefined,
  filters: Record<string, unknown>,
  ctx?: OrgContext,
) {
  if (type === "transactional") {
    const raw = await postmarkClient.getStats(filters as Parameters<typeof postmarkClient.getStats>[0], ctx);
    res.json({ transactional: toChannelStats(raw as ProviderStatsFlat) });
    return;
  }

  if (type === "broadcast") {
    const raw = await instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx);
    res.json({ broadcast: toChannelStats(raw as ProviderStatsFlat) });
    return;
  }

  // No type specified: aggregate both
  const [postmarkResult, instantlyResult] = await Promise.allSettled([
    postmarkClient.getStats(filters as Parameters<typeof postmarkClient.getStats>[0], ctx),
    instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx),
  ]);

  const response: Record<string, unknown> = {};

  if (postmarkResult.status === "fulfilled") {
    response.transactional = toChannelStats(postmarkResult.value as ProviderStatsFlat);
  } else {
    console.error(`[email-gateway] Postmark failed: ${postmarkResult.reason?.message}`);
    response.transactional = { error: postmarkResult.reason?.message };
  }

  if (instantlyResult.status === "fulfilled") {
    response.broadcast = toChannelStats(instantlyResult.value as ProviderStatsFlat);
  } else {
    console.error(`[email-gateway] Instantly failed: ${instantlyResult.reason?.message}`);
    response.broadcast = { error: instantlyResult.reason?.message };
  }

  res.json(response);
}

async function handleGrouped(
  res: Response,
  type: string | undefined,
  filters: Record<string, unknown>,
  ctx?: OrgContext,
) {
  const castFilters = filters as Parameters<typeof postmarkClient.getStats>[0];

  if (type === "transactional") {
    const raw = await postmarkClient.getStats(castFilters, ctx);
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
    const raw = await instantlyClient.getStats(castFilters, ctx);
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

  // No type: merge groups from both providers by key
  const [postmarkResult, instantlyResult] = await Promise.allSettled([
    postmarkClient.getStats(castFilters, ctx),
    instantlyClient.getStats(castFilters, ctx),
  ]);

  const merged = new Map<string, { transactional?: ChannelStats; broadcast?: ChannelStats }>();

  if (postmarkResult.status === "fulfilled" && isGrouped(postmarkResult.value)) {
    for (const g of postmarkResult.value.groups) {
      merged.set(g.key, { transactional: { recipientStats: g.recipientStats, emailStats: g.emailStats } });
    }
  } else if (postmarkResult.status === "rejected") {
    console.error(`[email-gateway] Postmark failed (grouped): ${postmarkResult.reason?.message}`);
  }

  if (instantlyResult.status === "fulfilled" && isGrouped(instantlyResult.value)) {
    for (const g of instantlyResult.value.groups) {
      const existing = merged.get(g.key) ?? {};
      existing.broadcast = { recipientStats: g.recipientStats, emailStats: g.emailStats };
      merged.set(g.key, existing);
    }
  } else if (instantlyResult.status === "fulfilled") {
    console.warn(`[email-gateway] Instantly returned non-grouped response when grouped was expected — broadcast stats dropped`);
  } else if (instantlyResult.status === "rejected") {
    console.error(`[email-gateway] Instantly failed (grouped): ${instantlyResult.reason?.message}`);
  }

  const groups = Array.from(merged.entries()).map(([key, value]) => ({
    key,
    ...value,
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
  const castFilters = providerFilters as Parameters<typeof postmarkClient.getStats>[0];

  // Fetch the dynasty map
  const fetchDynasties = dynastyGroupBy === "workflowDynastySlug"
    ? dynastyClient.fetchWorkflowDynasties
    : dynastyClient.fetchFeatureDynasties;

  const identityHeaders = ctx?.userId && ctx?.runId ? { orgId: ctx.orgId, userId: ctx.userId, runId: ctx.runId } : undefined;

  if (type === "transactional") {
    const [raw, dynasties] = await Promise.all([
      postmarkClient.getStats(castFilters, ctx),
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
      instantlyClient.getStats(castFilters, ctx),
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
  const [postmarkResult, instantlyResult, dynasties] = await Promise.all([
    postmarkClient.getStats(castFilters, ctx).catch((e: Error) => e),
    instantlyClient.getStats(castFilters, ctx).catch((e: Error) => e),
    fetchDynasties(identityHeaders),
  ]);

  const slugMap = dynastyClient.buildSlugToDynastyMap(dynasties);
  const merged = new Map<string, { transactional?: ChannelStats; broadcast?: ChannelStats }>();

  if (!(postmarkResult instanceof Error) && isGrouped(postmarkResult)) {
    const regrouped = regroupByDynasty(postmarkResult.groups, slugMap);
    for (const g of regrouped) {
      merged.set(g.key, { transactional: g.channelStats });
    }
  } else if (postmarkResult instanceof Error) {
    console.error(`[email-gateway] Postmark failed (dynasty grouped): ${postmarkResult.message}`);
  }

  if (!(instantlyResult instanceof Error) && isGrouped(instantlyResult)) {
    const regrouped = regroupByDynasty(instantlyResult.groups, slugMap);
    for (const g of regrouped) {
      const existing = merged.get(g.key) ?? {};
      existing.broadcast = g.channelStats;
      merged.set(g.key, existing);
    }
  } else if (!(instantlyResult instanceof Error)) {
    console.warn(`[email-gateway] Instantly returned non-grouped response when dynasty grouped was expected — broadcast stats dropped`);
  } else {
    console.error(`[email-gateway] Instantly failed (dynasty grouped): ${instantlyResult.message}`);
  }

  const groups = Array.from(merged.entries()).map(([key, value]) => ({
    key,
    ...value,
  }));

  res.json({ groups });
}

export default router;
export { internalRouter as publicStatsRouter };
