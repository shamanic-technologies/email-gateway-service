import { Router, Request, Response } from "express";
import { z } from "zod";
import { StatusRequestSchema } from "../schemas";
import type { OrgContext } from "../middleware/requireOrgId";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import { traceEvent } from "../lib/trace-event";

const router = Router();

router.post("/status", async (req: Request, res: Response) => {
  const parsed = StatusRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: z.flattenError(parsed.error) });
    return;
  }

  const { brandId, campaignId, items } = parsed.data;
  const ctx = res.locals.orgContext as OrgContext;

  traceEvent(ctx, "status.start", `items=${items.length} brandId=${brandId ?? "none"} campaignId=${campaignId ?? "none"}`);

  const payload = { brandId, campaignId, items };

  try {
    // Both providers are REQUIRED, and each must answer for every requested
    // address. A consumer reads an absent `broadcast` block as "never
    // contacted", so answering 200 with one provider missing — or with some
    // addresses missing from a provider's answer — is a partial answer that
    // looks complete. That is exactly what happened on 2026-09-24 while
    // instantly-service redeployed: its `fetch failed` was swallowed, ten
    // 100-address batches came back 200 with no broadcast evidence, and a
    // customer's `contacted` count dropped by exactly 1,000 for one refresh.
    // Refuse instead: the caller retries or keeps its last good figure.
    const [broadcast, transactional] = await Promise.all([
      instantlyClient.getStatus(payload, ctx),
      postmarkClient.getStatus(payload, ctx),
    ]);

    const broadcastMap = indexByEmail("instantly-service", broadcast.results, items);
    const transactionalMap = indexByEmail("postmark-service", transactional.results, items);

    const results = items.map((item) => {
      const broadcast = broadcastMap.get(item.email);
      const transactional = transactionalMap.get(item.email);

      const entry: Record<string, unknown> = {
        email: item.email,
      };

      if (broadcast) {
        entry.broadcast = {
          byCampaign: broadcast.byCampaign,
          campaign: broadcast.campaign,
          brand: broadcast.brand,
          global: broadcast.global,
        };
      }

      if (transactional) {
        entry.transactional = {
          byCampaign: transactional.byCampaign,
          campaign: transactional.campaign,
          brand: transactional.brand,
          global: transactional.global,
        };
      }

      return entry;
    });

    res.json({ results });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Failed: ${message}`);
    traceEvent(ctx, "status.error", message);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

/**
 * Index a provider's per-address answer, refusing one that does not cover
 * every requested address. Both providers answer one row per requested item,
 * so a missing address is a truncated answer, never "no data" (no data is a
 * row with empty scopes).
 */
function indexByEmail<T extends { email: string }>(
  provider: string,
  results: T[] | undefined,
  items: Array<{ email: string }>,
): Map<string, T> {
  if (!Array.isArray(results)) {
    throw new Error(`${provider} POST /orgs/status: response carried no results array`);
  }
  const map = new Map<string, T>();
  for (const r of results) map.set(r.email, r);
  const missing = items.filter((item) => !map.has(item.email)).length;
  if (missing > 0) {
    throw new Error(
      `${provider} POST /orgs/status: incomplete answer, ${missing} of ${items.length} requested addresses missing`,
    );
  }
  return map;
}

export default router;
