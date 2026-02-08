import { Router, Request, Response } from "express";
import { StatsRequestSchema, Stats } from "../schemas";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";

const router = Router();

function normalizePostmarkStats(raw: {
  stats: {
    emailsSent: number;
    emailsDelivered: number;
    emailsOpened: number;
    emailsClicked: number;
    emailsReplied: number;
    emailsBounced: number;
  };
}): Stats {
  return {
    sent: raw.stats.emailsSent,
    delivered: raw.stats.emailsDelivered,
    opened: raw.stats.emailsOpened,
    clicked: raw.stats.emailsClicked,
    replied: raw.stats.emailsReplied,
    bounced: raw.stats.emailsBounced,
    unsubscribed: 0,
    recipients: raw.stats.emailsSent,
  };
}

function normalizeInstantlyStats(raw: {
  stats: {
    totalLeads: number;
    contacted: number;
    opened: number;
    replied: number;
    bounced: number;
    unsubscribed: number;
  };
}): Stats {
  return {
    sent: raw.stats.contacted,
    delivered: 0,
    opened: raw.stats.opened,
    clicked: 0,
    replied: raw.stats.replied,
    bounced: raw.stats.bounced,
    unsubscribed: raw.stats.unsubscribed,
    recipients: raw.stats.totalLeads,
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
      res.json({ transactional: normalizePostmarkStats(raw) });
      return;
    }

    if (type === "broadcast") {
      const raw = await instantlyClient.getStats(filters);
      res.json({ broadcast: normalizeInstantlyStats(raw) });
      return;
    }

    // No type specified: aggregate both
    const [postmarkResult, instantlyResult] = await Promise.allSettled([
      postmarkClient.getStats(filters),
      instantlyClient.getStats(filters),
    ]);

    const response: Record<string, unknown> = {};

    if (postmarkResult.status === "fulfilled") {
      response.transactional = normalizePostmarkStats(postmarkResult.value);
    } else {
      response.transactional = { error: postmarkResult.reason?.message };
    }

    if (instantlyResult.status === "fulfilled") {
      response.broadcast = normalizeInstantlyStats(instantlyResult.value);
    } else {
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
