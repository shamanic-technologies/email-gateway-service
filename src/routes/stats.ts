import { Router, Request, Response } from "express";
import { StatsRequestSchema, Stats } from "../schemas";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";

const router = Router();

interface ProviderStatsResponse {
  stats: {
    emailsSent: number;
    emailsDelivered: number;
    emailsOpened: number;
    emailsClicked: number;
    emailsReplied: number;
    emailsBounced: number;
    repliesWillingToMeet?: number;
    repliesInterested?: number;
    repliesNotInterested?: number;
    repliesOutOfOffice?: number;
    repliesUnsubscribe?: number;
  };
  recipients?: number;
}

function normalizeProviderStats(raw: ProviderStatsResponse): Stats {
  return {
    emailsSent: raw.stats.emailsSent,
    emailsDelivered: raw.stats.emailsDelivered,
    emailsOpened: raw.stats.emailsOpened,
    emailsClicked: raw.stats.emailsClicked,
    emailsReplied: raw.stats.emailsReplied,
    emailsBounced: raw.stats.emailsBounced,
    repliesWillingToMeet: raw.stats.repliesWillingToMeet ?? 0,
    repliesInterested: raw.stats.repliesInterested ?? 0,
    repliesNotInterested: raw.stats.repliesNotInterested ?? 0,
    repliesOutOfOffice: raw.stats.repliesOutOfOffice ?? 0,
    repliesUnsubscribe: raw.stats.repliesUnsubscribe ?? 0,
    recipients: raw.recipients ?? raw.stats.emailsSent,
  };
}

router.post("/stats", async (req: Request, res: Response) => {
  const parsed = StatsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { type, ...filters } = parsed.data;

  try {
    if (type === "transactional") {
      const raw = await postmarkClient.getStats(filters);
      res.json({ transactional: normalizeProviderStats(raw) });
      return;
    }

    if (type === "broadcast") {
      const raw = await instantlyClient.getStats(filters);
      res.json({ broadcast: normalizeProviderStats(raw) });
      return;
    }

    // No type specified: aggregate both
    const [postmarkResult, instantlyResult] = await Promise.allSettled([
      postmarkClient.getStats(filters),
      instantlyClient.getStats(filters),
    ]);

    const response: Record<string, unknown> = {};

    if (postmarkResult.status === "fulfilled") {
      response.transactional = normalizeProviderStats(postmarkResult.value);
    } else {
      console.error(`[stats] Postmark failed: ${postmarkResult.reason?.message}`);
      response.transactional = { error: postmarkResult.reason?.message };
    }

    if (instantlyResult.status === "fulfilled") {
      response.broadcast = normalizeProviderStats(instantlyResult.value);
    } else {
      console.error(`[stats] Instantly failed: ${instantlyResult.reason?.message}`);
      response.broadcast = { error: instantlyResult.reason?.message };
    }

    res.json(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[stats] Failed: ${message}`);
    res.status(502).json({ error: "Failed to fetch stats", details: message });
  }
});

export default router;
