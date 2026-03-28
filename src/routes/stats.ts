import { Router, Request, Response } from "express";
import { StatsQuerySchema, Stats, BroadcastStats } from "../schemas";
import { extractTrackingHeaders, TrackingHeaders } from "../middleware/identityHeaders";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import * as dynastyClient from "../lib/dynasty-client";
import type {
  ProviderStatsFlat,
  ProviderStatsGrouped,
  ProviderStatsPayload,
  ProviderStatsResult,
  ProviderStepStats,
} from "../lib/instantly-client";

const router = Router();
const publicRouter = Router();

function normalizePayload(raw: ProviderStatsPayload, recipients?: number): Stats {
  return {
    emailsContacted: raw.emailsContacted ?? 0,
    emailsSent: raw.emailsSent,
    emailsDelivered: raw.emailsDelivered,
    emailsOpened: raw.emailsOpened,
    emailsClicked: raw.emailsClicked,
    emailsReplied: raw.emailsReplied,
    emailsBounced: raw.emailsBounced,
    repliesWillingToMeet: raw.repliesWillingToMeet ?? 0,
    repliesInterested: raw.repliesInterested ?? 0,
    repliesNotInterested: raw.repliesNotInterested ?? 0,
    repliesOutOfOffice: raw.repliesOutOfOffice ?? 0,
    repliesUnsubscribe: raw.repliesUnsubscribe ?? 0,
    recipients: recipients ?? raw.emailsSent,
  };
}

function normalizeBroadcastFlat(raw: ProviderStatsFlat): BroadcastStats {
  const base = normalizePayload(raw.stats, raw.recipients);
  return raw.stepStats ? { ...base, stepStats: raw.stepStats } : base;
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
  emailsReplied: 0,
  emailsBounced: 0,
  repliesWillingToMeet: 0,
  repliesInterested: 0,
  repliesNotInterested: 0,
  repliesOutOfOffice: 0,
  repliesUnsubscribe: 0,
  recipients: 0,
};

function addStats(a: Stats, b: Stats): Stats {
  return {
    emailsContacted: a.emailsContacted + b.emailsContacted,
    emailsSent: a.emailsSent + b.emailsSent,
    emailsDelivered: a.emailsDelivered + b.emailsDelivered,
    emailsOpened: a.emailsOpened + b.emailsOpened,
    emailsClicked: a.emailsClicked + b.emailsClicked,
    emailsReplied: a.emailsReplied + b.emailsReplied,
    emailsBounced: a.emailsBounced + b.emailsBounced,
    repliesWillingToMeet: a.repliesWillingToMeet + b.repliesWillingToMeet,
    repliesInterested: a.repliesInterested + b.repliesInterested,
    repliesNotInterested: a.repliesNotInterested + b.repliesNotInterested,
    repliesOutOfOffice: a.repliesOutOfOffice + b.repliesOutOfOffice,
    repliesUnsubscribe: a.repliesUnsubscribe + b.repliesUnsubscribe,
    recipients: a.recipients + b.recipients,
  };
}

function parseStatsInput(req: Request): { success: true; type?: string; filters: Record<string, unknown> } | { success: false; error: unknown } {
  const parsed = StatsQuerySchema.safeParse(req.query);
  if (!parsed.success) return { success: false, error: parsed.error.flatten() };
  const { type, runIds, workflowSlugs, ...rest } = parsed.data;
  const filters: Record<string, unknown> = { ...rest };
  if (runIds) filters.runIds = runIds.split(",").map((s) => s.trim());
  if (workflowSlugs) filters.workflowSlugs = workflowSlugs.split(",").map((s) => s.trim());
  return { success: true, type, filters };
}

/** Resolve dynasty slugs into versioned slug arrays and rewrite filters for downstream providers */
async function resolveDynastyFilters(filters: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resolved = { ...filters };

  // workflowDynastySlug → resolve to workflowSlugs
  const workflowDynastySlug = resolved.workflowDynastySlug as string | undefined;
  if (workflowDynastySlug) {
    const slugs = await dynastyClient.resolveWorkflowDynastySlugs(workflowDynastySlug);
    if (slugs.length === 0) return { __empty: true };
    resolved.workflowSlugs = slugs;
    delete resolved.workflowSlug;
    delete resolved.workflowDynastySlug;
  }

  // featureDynastySlug → resolve to featureSlugs
  const featureDynastySlug = resolved.featureDynastySlug as string | undefined;
  if (featureDynastySlug) {
    const slugs = await dynastyClient.resolveFeatureDynastySlugs(featureDynastySlug);
    if (slugs.length === 0) return { __empty: true };
    resolved.featureSlugs = slugs;
    delete resolved.featureSlug;
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

async function statsHandler(req: Request, res: Response) {
  const input = parseStatsInput(req);
  if (!input.success) {
    res.status(400).json({ error: "Invalid request", details: input.error });
    return;
  }

  const orgId = (res.locals.orgId ?? req.headers["x-org-id"]) as string | undefined;
  const userId = (res.locals.userId ?? req.headers["x-user-id"]) as string | undefined;
  const runId = (res.locals.runId ?? req.headers["x-run-id"]) as string | undefined;
  const identityHeaders = orgId && userId && runId ? { orgId, userId, runId } : undefined;
  const trackingHeaders: TrackingHeaders = res.locals.trackingHeaders ?? extractTrackingHeaders(req);
  const { type } = input;

  try {
    // Resolve dynasty filters
    const resolvedFilters = await resolveDynastyFilters(input.filters);

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

    const filters: Record<string, unknown> = { ...resolvedFilters, ...(orgId && { orgId }), ...(userId && { userId }) };

    if (filters.groupBy) {
      if (isDynastyGroupBy(input.filters.groupBy)) {
        return await handleDynastyGrouped(res, type, filters, input.filters.groupBy as "workflowDynastySlug" | "featureDynastySlug", identityHeaders, trackingHeaders);
      }
      return await handleGrouped(res, type, filters, identityHeaders, trackingHeaders);
    }

    return await handleFlat(res, type, filters, identityHeaders, trackingHeaders);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Stats failed: ${message}`);
    res.status(502).json({ error: "Failed to fetch stats", details: message });
  }
}

router.get("/stats", statsHandler);
publicRouter.get("/stats/public", statsHandler);

async function handleFlat(
  res: Response,
  type: string | undefined,
  filters: Record<string, unknown>,
  identityHeaders?: { orgId: string; userId: string; runId: string },
  trackingHeaders?: TrackingHeaders,
) {
  if (type === "transactional") {
    const raw = await postmarkClient.getStats(filters as Parameters<typeof postmarkClient.getStats>[0], identityHeaders, trackingHeaders);
    res.json({ transactional: normalizeFlatResult(raw) });
    return;
  }

  if (type === "broadcast") {
    const raw = await instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], identityHeaders, trackingHeaders);
    const flat = raw as ProviderStatsFlat;
    res.json({ broadcast: normalizeBroadcastFlat(flat) });
    return;
  }

  // No type specified: aggregate both
  const [postmarkResult, instantlyResult] = await Promise.allSettled([
    postmarkClient.getStats(filters as Parameters<typeof postmarkClient.getStats>[0], identityHeaders, trackingHeaders),
    instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], identityHeaders, trackingHeaders),
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
  identityHeaders?: { orgId: string; userId: string; runId: string },
  trackingHeaders?: TrackingHeaders,
) {
  const castFilters = filters as Parameters<typeof postmarkClient.getStats>[0];

  if (type === "transactional") {
    const raw = await postmarkClient.getStats(castFilters, identityHeaders, trackingHeaders);
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
    const raw = await instantlyClient.getStats(castFilters, identityHeaders, trackingHeaders);
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
    postmarkClient.getStats(castFilters, identityHeaders, trackingHeaders),
    instantlyClient.getStats(castFilters, identityHeaders, trackingHeaders),
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
  identityHeaders?: { orgId: string; userId: string; runId: string },
  trackingHeaders?: TrackingHeaders,
) {
  // Rewrite groupBy for downstream providers
  const providerGroupBy = rewriteGroupByForProvider(dynastyGroupBy);
  const providerFilters = { ...filters, groupBy: providerGroupBy };
  const castFilters = providerFilters as Parameters<typeof postmarkClient.getStats>[0];

  // Fetch the dynasty map
  const fetchDynasties = dynastyGroupBy === "workflowDynastySlug"
    ? dynastyClient.fetchWorkflowDynasties
    : dynastyClient.fetchFeatureDynasties;

  if (type === "transactional") {
    const [raw, dynasties] = await Promise.all([
      postmarkClient.getStats(castFilters, identityHeaders, trackingHeaders),
      fetchDynasties(),
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
      instantlyClient.getStats(castFilters, identityHeaders, trackingHeaders),
      fetchDynasties(),
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
    postmarkClient.getStats(castFilters, identityHeaders, trackingHeaders).catch((e: Error) => e),
    instantlyClient.getStats(castFilters, identityHeaders, trackingHeaders).catch((e: Error) => e),
    fetchDynasties(),
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
export { publicRouter as publicStatsRouter };
