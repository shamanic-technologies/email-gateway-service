import { Router, Request, Response } from "express";
import { z } from "zod";
import { StatsQuerySchema, MAX_STATS_CAMPAIGN_IDS, OperationStatsQuerySchema, PublicEngagementLatencyQuerySchema, ChannelStats, RecipientStats, EmailStats, RepliesDetail } from "../schemas";
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

type StatsInput = {
  success: true;
  type?: string;
  filters: Record<string, unknown>;
  // Set on a campaign-family read: every row is read with `campaignId=<row>`.
  campaignIds?: string[];
  perCampaign: boolean;
};

function parseStatsInput(req: Request): StatsInput | { success: false; error: unknown } {
  const parsed = StatsQuerySchema.safeParse(req.query);
  if (!parsed.success) return { success: false, error: z.flattenError(parsed.error) };
  const { type, runIds, workflowSlugs, featureSlugs, campaignIds: rawCampaignIds, perCampaign, ...rest } = parsed.data;
  const filters: Record<string, unknown> = { ...rest };
  if (runIds) filters.runIds = runIds.split(",").map((s) => s.trim());
  if (workflowSlugs) filters.workflowSlugs = workflowSlugs.split(",").map((s) => s.trim()).join(",");
  if (featureSlugs) filters.featureSlugs = featureSlugs.split(",").map((s) => s.trim()).join(",");

  if (rawCampaignIds === undefined) {
    if (perCampaign !== undefined) return { success: false, error: "perCampaign is only accepted together with campaignIds" };
    return { success: true, type, filters, perCampaign: false };
  }
  if (rest.campaignId !== undefined) return { success: false, error: "campaignId and campaignIds are mutually exclusive" };
  const campaignIds = parseCommaSeparatedSlugs(rawCampaignIds);
  if (campaignIds.length === 0) return { success: false, error: "campaignIds must name at least one campaign" };
  if (campaignIds.length > MAX_STATS_CAMPAIGN_IDS) {
    return { success: false, error: `campaignIds accepts at most ${MAX_STATS_CAMPAIGN_IDS} ids (got ${campaignIds.length})` };
  }
  return { success: true, type, filters, campaignIds, perCampaign: perCampaign === "true" };
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

type StatsBody = Record<string, unknown>;
type DynastyCache = Map<string, ReturnType<typeof dynastyClient.fetchWorkflowDynasties>>;

// How many campaign rows a family read has in flight at once. Each row costs at
// most one read per provider, so this bounds the gateway at 2x sockets. Measured
// on prod (2026-09-24, a 47-row family): 16 in flight answered in ~70-190ms.
const CAMPAIGN_FAMILY_CONCURRENCY = 16;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Add two provider answers field by field. Numbers add; objects add key by key
 * over the union of their keys (so a field one provider version serves and
 * another does not — `notSending`, a new reply kind — is carried, not dropped);
 * `stepStats` arrays add per `step`. Anything else keeps the first value seen.
 */
function sumDeep(a: unknown, b: unknown): unknown {
  if (a === undefined || a === null) return b;
  if (b === undefined || b === null) return a;
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return sumByStep(a, b);
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [key, value] of Object.entries(b as Record<string, unknown>)) out[key] = sumDeep(out[key], value);
    return out;
  }
  return a;
}

function sumByStep(a: unknown[], b: unknown[]): unknown[] {
  const byStep = new Map<unknown, unknown>();
  for (const entry of [...a, ...b]) {
    const step = (entry as { step?: unknown } | null)?.step;
    if (step === undefined) throw new Error("cannot add a stats array whose entries carry no step");
    const existing = byStep.get(step);
    // `step` is the key, not a count: keep it rather than adding it to itself.
    byStep.set(step, existing === undefined ? entry : { ...(sumDeep(existing, entry) as object), step });
  }
  return Array.from(byStep.values()).sort((x, y) => Number((x as { step: number }).step) - Number((y as { step: number }).step));
}

/** Sum per-row bodies into one body of the same shape (flat or grouped). */
function combineBodies(bodies: StatsBody[]): StatsBody {
  if (bodies.some((body) => Array.isArray(body.groups))) {
    const merged = new Map<string, Record<string, unknown>>();
    for (const body of bodies) {
      if (!Array.isArray(body.groups)) throw new Error("campaign rows answered in different shapes (grouped and flat)");
      for (const group of body.groups as Array<Record<string, unknown>>) {
        const key = String(group.key);
        const existing = merged.get(key);
        merged.set(key, existing ? { ...(sumDeep(existing, group) as Record<string, unknown>), key } : group);
      }
    }
    return { groups: Array.from(merged.values()) };
  }
  return bodies.reduce<StatsBody>((acc, body) => sumDeep(acc, body) as StatsBody, {});
}

async function computeStatsBody(
  type: string | undefined,
  inputFilters: Record<string, unknown>,
  resolvedFilters: Record<string, unknown>,
  ctx: OrgContext | undefined,
  dynastyCache?: DynastyCache,
): Promise<StatsBody> {
  const filters: Record<string, unknown> = { ...resolvedFilters, ...(ctx?.orgId && { orgId: ctx.orgId }), ...(ctx?.userId && { userId: ctx.userId }) };

  if (filters.groupBy) {
    if (isDynastyGroupBy(inputFilters.groupBy)) {
      return handleDynastyGrouped(type, filters, inputFilters.groupBy as "workflowDynastySlug" | "featureDynastySlug", ctx, dynastyCache);
    }
    return handleGrouped(type, filters, ctx);
  }
  return handleFlat(type, filters, ctx);
}

function emptyBody(type: string | undefined, grouped: boolean): StatsBody {
  if (grouped) return { groups: [] };
  const response: StatsBody = {};
  if (!type || type === "transactional") response.transactional = { ...ZERO_CHANNEL_STATS };
  if (!type || type === "broadcast") response.broadcast = { ...ZERO_CHANNEL_STATS };
  return response;
}

async function statsHandler(req: Request, res: Response) {
  const input = parseStatsInput(req);
  if (!input.success) {
    res.status(400).json({ error: "Invalid request", details: input.error });
    return;
  }

  // For org-scoped routes, ctx comes from middleware. For public routes, try to extract from headers.
  const ctx: OrgContext | undefined = res.locals.orgContext ?? extractOrgContext(req) ?? extractPartialContext(req);
  const { type, campaignIds } = input;

  try {
    // Resolve dynasty filters (once, whatever the number of campaign rows)
    const resolvedFilters = await resolveDynastyFilters(input.filters, ctx);

    if (!campaignIds) {
      // If dynasty slug resolved to empty → return zero stats immediately
      if (resolvedFilters.__empty) {
        res.json(emptyBody(type, Boolean(input.filters.groupBy)));
        return;
      }
      res.json(await computeStatsBody(type, input.filters, resolvedFilters, ctx));
      return;
    }

    // Campaign-family read: the SAME read a caller makes with `campaignId=<row>`,
    // once per row, then added. Summing per row (rather than asking a provider
    // for the rows as one set) is what keeps the figures identical to the
    // per-row answers: recipient counts are distinct WITHIN a row, so a
    // recipient under two rows counts once per row in both. Promise.all: one
    // failed row fails the whole read — a partial sum reads as a real drop.
    let perRow: StatsBody[];
    if (resolvedFilters.__empty) {
      perRow = campaignIds.map(() => emptyBody(type, Boolean(input.filters.groupBy)));
    } else {
      const dynastyCache: DynastyCache = new Map();
      perRow = await mapWithConcurrency(campaignIds, CAMPAIGN_FAMILY_CONCURRENCY, (campaignId) =>
        computeStatsBody(type, input.filters, { ...resolvedFilters, campaignId }, ctx, dynastyCache),
      );
    }

    const body = combineBodies(perRow);
    if (input.perCampaign) {
      body.byCampaign = Object.fromEntries(campaignIds.map((id, index) => [id, perRow[index]]));
    }
    res.json(body);
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
  type: string | undefined,
  filters: Record<string, unknown>,
  ctx?: OrgContext,
): Promise<StatsBody> {
  if (type === "transactional") {
    const raw = await postmarkClient.getStats(withoutBroadcastOnlyFilters(filters) as Parameters<typeof postmarkClient.getStats>[0], ctx);
    return { transactional: toChannelStats(raw as ProviderStatsFlat) };
  }

  if (type === "broadcast") {
    const raw = await instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx);
    return { broadcast: toChannelStats(raw as ProviderStatsFlat) };
  }

  // No type specified: aggregate both. Both are required — a provider that
  // fails rejects the whole read (502 via statsHandler), never a 200 with one
  // channel missing, which a consumer summing channels reads as a real drop.
  const [postmarkRaw, instantlyRaw] = await Promise.all([
    postmarkClient.getStats(withoutBroadcastOnlyFilters(filters) as Parameters<typeof postmarkClient.getStats>[0], ctx),
    instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx),
  ]);

  return {
    transactional: toChannelStats(postmarkRaw as ProviderStatsFlat),
    broadcast: toChannelStats(instantlyRaw as ProviderStatsFlat),
  };
}

async function handleGrouped(
  type: string | undefined,
  filters: Record<string, unknown>,
  ctx?: OrgContext,
): Promise<StatsBody> {
  if (isBroadcastOnlyGroupBy(filters)) {
    return await handleBroadcastOnlyGrouped(type, filters, ctx);
  }

  const postmarkFilters = withoutBroadcastOnlyFilters(filters) as Parameters<typeof postmarkClient.getStats>[0];
  const instantlyFilters = filters as Parameters<typeof instantlyClient.getStats>[0];

  if (type === "transactional") {
    const raw = await postmarkClient.getStats(postmarkFilters, ctx);
    if (!isGrouped(raw)) {
      return { groups: [] };
    }
    const groups = raw.groups.map((g) => ({
      key: g.key,
      transactional: { recipientStats: g.recipientStats, emailStats: g.emailStats } as ChannelStats,
    }));
    return { groups };
  }

  if (type === "broadcast") {
    const raw = await instantlyClient.getStats(instantlyFilters, ctx);
    if (!isGrouped(raw)) {
      return { groups: [] };
    }
    const groups = raw.groups.map((g) => ({
      key: g.key,
      broadcast: { recipientStats: g.recipientStats, emailStats: g.emailStats } as ChannelStats,
    }));
    return { groups };
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

  return { groups };
}

async function handleBroadcastOnlyGrouped(
  type: string | undefined,
  filters: Record<string, unknown>,
  ctx?: OrgContext,
): Promise<StatsBody> {
  if (type === "transactional") {
    return { groups: [] };
  }

  const raw = await instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0], ctx);
  if (!isGrouped(raw)) {
    return { groups: [] };
  }

  const groups = raw.groups.map((g) => ({
    key: g.key,
    broadcast: { recipientStats: g.recipientStats, emailStats: g.emailStats } as ChannelStats,
  }));
  return { groups };
}

async function handleDynastyGrouped(
  type: string | undefined,
  filters: Record<string, unknown>,
  dynastyGroupBy: "workflowDynastySlug" | "featureDynastySlug",
  ctx?: OrgContext,
  dynastyCache?: DynastyCache,
): Promise<StatsBody> {
  // Rewrite groupBy for downstream providers
  const providerGroupBy = rewriteGroupByForProvider(dynastyGroupBy);
  const providerFilters = { ...filters, groupBy: providerGroupBy };
  const postmarkFilters = withoutBroadcastOnlyFilters(providerFilters) as Parameters<typeof postmarkClient.getStats>[0];
  const instantlyFilters = providerFilters as Parameters<typeof instantlyClient.getStats>[0];

  // Fetch the dynasty map — once per request, however many campaign rows share it
  const fetchUncached = dynastyGroupBy === "workflowDynastySlug"
    ? dynastyClient.fetchWorkflowDynasties
    : dynastyClient.fetchFeatureDynasties;
  const fetchDynasties: typeof fetchUncached = (headers) => {
    if (!dynastyCache) return fetchUncached(headers);
    let pending = dynastyCache.get(dynastyGroupBy);
    if (!pending) {
      pending = fetchUncached(headers);
      dynastyCache.set(dynastyGroupBy, pending);
    }
    return pending;
  };

  const identityHeaders = ctx?.userId && ctx?.runId ? { orgId: ctx.orgId, userId: ctx.userId, runId: ctx.runId } : undefined;

  if (type === "transactional") {
    const [raw, dynasties] = await Promise.all([
      postmarkClient.getStats(postmarkFilters, ctx),
      fetchDynasties(identityHeaders),
    ]);
    const slugMap = dynastyClient.buildSlugToDynastyMap(dynasties);
    if (!isGrouped(raw)) {
      return { groups: [] };
    }
    const regrouped = regroupByDynasty(raw.groups, slugMap);
    return { groups: regrouped.map((g) => ({ key: g.key, transactional: g.channelStats })) };
  }

  if (type === "broadcast") {
    const [raw, dynasties] = await Promise.all([
      instantlyClient.getStats(instantlyFilters, ctx),
      fetchDynasties(identityHeaders),
    ]);
    const slugMap = dynastyClient.buildSlugToDynastyMap(dynasties);
    if (!isGrouped(raw)) {
      return { groups: [] };
    }
    const regrouped = regroupByDynasty(raw.groups, slugMap);
    return { groups: regrouped.map((g) => ({ key: g.key, broadcast: g.channelStats })) };
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

  return { groups };
}

export default router;
export { internalRouter as publicStatsRouter };
