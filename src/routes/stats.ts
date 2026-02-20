import { Router, Request, Response } from "express";
import { StatsRequestSchema, Stats, BroadcastStats } from "../schemas";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import type {
  ProviderStatsFlat,
  ProviderStatsGrouped,
  ProviderStatsPayload,
  ProviderStatsResult,
  ProviderStepStats,
} from "../lib/instantly-client";

const router = Router();

function normalizePayload(raw: ProviderStatsPayload, recipients?: number): Stats {
  return {
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

router.post("/stats", async (req: Request, res: Response) => {
  const parsed = StatsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { type, ...filters } = parsed.data;

  try {
    if (filters.groupBy) {
      return await handleGrouped(res, type, filters);
    }

    return await handleFlat(res, type, filters);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[stats] Failed: ${message}`);
    res.status(502).json({ error: "Failed to fetch stats", details: message });
  }
});

async function handleFlat(
  res: Response,
  type: string | undefined,
  filters: Record<string, unknown>,
) {
  if (type === "transactional") {
    const raw = await postmarkClient.getStats(filters as Parameters<typeof postmarkClient.getStats>[0]);
    res.json({ transactional: normalizeFlatResult(raw) });
    return;
  }

  if (type === "broadcast") {
    const raw = await instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0]);
    const flat = raw as ProviderStatsFlat;
    res.json({ broadcast: normalizeBroadcastFlat(flat) });
    return;
  }

  // No type specified: aggregate both
  const [postmarkResult, instantlyResult] = await Promise.allSettled([
    postmarkClient.getStats(filters as Parameters<typeof postmarkClient.getStats>[0]),
    instantlyClient.getStats(filters as Parameters<typeof instantlyClient.getStats>[0]),
  ]);

  const response: Record<string, unknown> = {};

  if (postmarkResult.status === "fulfilled") {
    response.transactional = normalizeFlatResult(postmarkResult.value);
  } else {
    console.error(`[stats] Postmark failed: ${postmarkResult.reason?.message}`);
    response.transactional = { error: postmarkResult.reason?.message };
  }

  if (instantlyResult.status === "fulfilled") {
    const flat = instantlyResult.value as ProviderStatsFlat;
    response.broadcast = normalizeBroadcastFlat(flat);
  } else {
    console.error(`[stats] Instantly failed: ${instantlyResult.reason?.message}`);
    response.broadcast = { error: instantlyResult.reason?.message };
  }

  res.json(response);
}

async function handleGrouped(
  res: Response,
  type: string | undefined,
  filters: Record<string, unknown>,
) {
  const castFilters = filters as Parameters<typeof postmarkClient.getStats>[0];

  if (type === "transactional") {
    const raw = await postmarkClient.getStats(castFilters);
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
    const raw = await instantlyClient.getStats(castFilters);
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
    postmarkClient.getStats(castFilters),
    instantlyClient.getStats(castFilters),
  ]);

  const merged = new Map<string, { transactional?: Stats; broadcast?: Stats }>();

  if (postmarkResult.status === "fulfilled" && isGrouped(postmarkResult.value)) {
    for (const g of postmarkResult.value.groups) {
      merged.set(g.key, { transactional: normalizePayload(g.stats, g.recipients) });
    }
  } else if (postmarkResult.status === "rejected") {
    console.error(`[stats] Postmark failed (grouped): ${postmarkResult.reason?.message}`);
  }

  if (instantlyResult.status === "fulfilled" && isGrouped(instantlyResult.value)) {
    for (const g of instantlyResult.value.groups) {
      const existing = merged.get(g.key) ?? {};
      existing.broadcast = normalizePayload(g.stats, g.recipients);
      merged.set(g.key, existing);
    }
  } else if (instantlyResult.status === "rejected") {
    console.error(`[stats] Instantly failed (grouped): ${instantlyResult.reason?.message}`);
  }

  const groups = Array.from(merged.entries()).map(([key, value]) => ({
    key,
    ...value,
  }));

  res.json({ groups });
}

export default router;
