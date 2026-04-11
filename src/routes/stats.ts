import { Router, Request, Response } from "express";
import { StatsQuerySchema, Stats, StepStats, BroadcastStats } from "../schemas";
import type { OrgContext } from "../middleware/requireOrgId";
import { extractOrgContext, parseBrandIds } from "../middleware/requireOrgId";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import * as dynastyClient from "../lib/dynasty-client";
import type {
  ProviderRepliesDetail,
  ProviderStatsFlat,
  ProviderStatsGrouped,
  ProviderStatsPayload,
  ProviderStatsResult,
  ProviderStepStats,
} from "../lib/instantly-client";
import type { RepliesDetail } from "../schemas";

const router = Router();
const internalRouter = Router();

const ZERO_DETAIL: RepliesDetail = {
  interested: 0, meetingBooked: 0, closed: 0,
  notInterested: 0, wrongPerson: 0, unsubscribe: 0,
  neutral: 0, autoReply: 0, outOfOffice: 0,
};

function normalizeDetail(raw?: ProviderRepliesDetail): RepliesDetail {
  if (!raw) return { ...ZERO_DETAIL };
  return {
    interested: raw.interested ?? 0,
    meetingBooked: raw.meetingBooked ?? 0,
    closed: raw.closed ?? 0,
    notInterested: raw.notInterested ?? 0,
    wrongPerson: raw.wrongPerson ?? 0,
    unsubscribe: raw.unsubscribe ?? 0,
    neutral: raw.neutral ?? 0,
    autoReply: raw.autoReply ?? 0,
    outOfOffice: raw.outOfOffice ?? 0,
  };
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

function normalizePayload(raw: ProviderStatsPayload, recipients?: number): Stats {
  return {
    emailsContacted: raw.emailsContacted ?? 0,
    emailsSent: raw.emailsSent,
    emailsDelivered: raw.emailsDelivered,
    emailsOpened: raw.emailsOpened,
    emailsClicked: raw.emailsClicked,
    emailsBounced: raw.emailsBounced,
    repliesPositive: raw.repliesPositive ?? 0,
    repliesNegative: raw.repliesNegative ?? 0,
    repliesNeutral: raw.repliesNeutral ?? 0,
    repliesAutoReply: raw.repliesAutoReply ?? 0,
    repliesDetail: normalizeDetail(raw.repliesDetail),
    recipients: recipients ?? raw.emailsSent,
  };
}

function normalizeStepStats(steps: ProviderStepStats[]): StepStats[] {
  return steps.map((s) => ({
    step: s.step,
    emailsSent: s.emailsSent,
    emailsOpened: s.emailsOpened,
    emailsBounced: s.emailsBounced,
    repliesPositive: s.repliesPositive ?? 0,
    repliesNegative: s.repliesNegative ?? 0,
    repliesNeutral: s.repliesNeutral ?? 0,
    repliesAutoReply: s.repliesAutoReply ?? 0,
    repliesDetail: normalizeDetail(s.repliesDetail),
  }));
}

function normalizeBroadcastFlat(raw: ProviderStatsFlat): BroadcastStats {
  const base = normalizePayload(raw.stats, raw.recipients);
  return raw.stepStats ? { ...base, stepStats: normalizeStepStats(raw.stepStats) } : base;
}

function isGrouped(result: ProviderStatsResult): result is ProviderStatsGrouped {
  return "groups" in result;
}

function normalizeFlatResult(raw: ProviderStatsResult): Stats {
  const flat = raw as ProviderStatsFlat;
  return normalizePayload(flat.stats, flat.recipients);
}

const ZERO_STATS: Stats = {
  emailsContacted: 0,
  emailsSent: 0,
  emailsDelivered: 0,
  emailsOpened: 0,
  emailsClicked: 0,
  emailsBounced: 0,
  repliesPositive: 0,
  repliesNegative: 0,
  repliesNeutral: 0,
  repliesAutoReply: 0,
  repliesDetail: { ...ZERO_DETAIL },
  recipients: 0,
};

function addStats(a: Stats, b: Stats): Stats {
  return {
    emailsContacted: a.emailsContacted + b.emailsContacted,
    emailsSent: a.emailsSent + b.emailsSent,
    emailsDelivered: a.emailsDelivered + b.emailsDelivered,
    emailsOpened: a.emailsOpened + b.emailsOpened,
    emailsClicked: a.emailsClicked + b.emailsClicked,
    emailsBounced: a.emailsBounced + b.emailsBounced,
    repliesPositive: a.repliesPositive + b.repliesPositive,
    repliesNegative: a.repliesNegative + b.repliesNegative,
    repliesNeutral: a.repliesNeutral + b.repliesNeutral,
    repliesAutoReply: a.repliesAutoReply + b.repliesAutoReply,
    repliesDetail: addDetail(a.repliesDetail, b.repliesDetail),
    recipients: a.recipients + b.recipients,
  };
}

function parseStatsInput(req: Request): { success: true; type?: string; filters: Record<string, unknown> } | { success: false; error: unknown } {
  const parsed = StatsQuerySchema.safeParse(req.query);
  if (!parsed.success) return { success: false, error: parsed.error.flatten() };
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
  groups: Array<{ key: string; stats: ProviderStatsPayload; recipients?: number }>,
  slugToDynastyMap: Map<string, string>,
): Array<{ key: string; stats: Stats }> {
  const dynastyGroups = new Map<string, Stats>();
  for (const g of groups) {
    const dynastyKey = slugToDynastyMap.get(g.key) ?? g.key;
    const normalized = normalizePayload(g.stats, g.recipients);
    const existing = dynastyGroups.get(dynastyKey) ?? { ...ZERO_STATS };
    dynastyGroups.set(dynastyKey, addStats(existing, normalized));
  }
  return Array.from(dynastyGroups.entries()).map(([key, stats]) => ({ key, stats }));
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
    brandIds: parseBrandIds(brandId),
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
        if (!type || type === "transactional") response.transactional = { ...ZERO_STATS };
        if (!type || type === "broadcast") response.broadcast = { ...ZERO_STATS };
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
    res.json({ transactional: normalizeFlatResult(raw) });
    return;
  }

  if (type === "broadcast") {
    const raw = await instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx);
    const flat = raw as ProviderStatsFlat;
    res.json({ broadcast: normalizeBroadcastFlat(flat) });
    return;
  }

  // No type specified: aggregate both
  const [postmarkResult, instantlyResult] = await Promise.allSettled([
    postmarkClient.getStats(filters as Parameters<typeof postmarkClient.getStats>[0], ctx),
    instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx),
  ]);

  const response: Record<string, unknown> = {};

  if (postmarkResult.status === "fulfilled") {
    response.transactional = normalizeFlatResult(postmarkResult.value);
  } else {
    console.error(`[email-gateway] Postmark failed: ${postmarkResult.reason?.message}`);
    response.transactional = { error: postmarkResult.reason?.message };
  }

  if (instantlyResult.status === "fulfilled") {
    const flat = instantlyResult.value as ProviderStatsFlat;
    response.broadcast = normalizeBroadcastFlat(flat);
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
      transactional: normalizePayload(g.stats, g.recipients),
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
      broadcast: normalizePayload(g.stats, g.recipients),
    }));
    res.json({ groups });
    return;
  }

  // No type: merge groups from both providers by key
  const [postmarkResult, instantlyResult] = await Promise.allSettled([
    postmarkClient.getStats(castFilters, ctx),
    instantlyClient.getStats(castFilters, ctx),
  ]);

  const merged = new Map<string, { transactional?: Stats; broadcast?: Stats }>();

  if (postmarkResult.status === "fulfilled" && isGrouped(postmarkResult.value)) {
    for (const g of postmarkResult.value.groups) {
      merged.set(g.key, { transactional: normalizePayload(g.stats, g.recipients) });
    }
  } else if (postmarkResult.status === "rejected") {
    console.error(`[email-gateway] Postmark failed (grouped): ${postmarkResult.reason?.message}`);
  }

  if (instantlyResult.status === "fulfilled" && isGrouped(instantlyResult.value)) {
    for (const g of instantlyResult.value.groups) {
      const existing = merged.get(g.key) ?? {};
      existing.broadcast = normalizePayload(g.stats, g.recipients);
      merged.set(g.key, existing);
    }
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
    res.json({ groups: regrouped.map((g) => ({ key: g.key, transactional: g.stats })) });
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
    res.json({ groups: regrouped.map((g) => ({ key: g.key, broadcast: g.stats })) });
    return;
  }

  // No type: merge both providers
  const [postmarkResult, instantlyResult, dynasties] = await Promise.all([
    postmarkClient.getStats(castFilters, ctx).catch((e: Error) => e),
    instantlyClient.getStats(castFilters, ctx).catch((e: Error) => e),
    fetchDynasties(identityHeaders),
  ]);

  const slugMap = dynastyClient.buildSlugToDynastyMap(dynasties);
  const merged = new Map<string, { transactional?: Stats; broadcast?: Stats }>();

  if (!(postmarkResult instanceof Error) && isGrouped(postmarkResult)) {
    const regrouped = regroupByDynasty(postmarkResult.groups, slugMap);
    for (const g of regrouped) {
      merged.set(g.key, { transactional: g.stats });
    }
  } else if (postmarkResult instanceof Error) {
    console.error(`[email-gateway] Postmark failed (dynasty grouped): ${postmarkResult.message}`);
  }

  if (!(instantlyResult instanceof Error) && isGrouped(instantlyResult)) {
    const regrouped = regroupByDynasty(instantlyResult.groups, slugMap);
    for (const g of regrouped) {
      const existing = merged.get(g.key) ?? {};
      existing.broadcast = g.stats;
      merged.set(g.key, existing);
    }
  } else if (instantlyResult instanceof Error) {
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
