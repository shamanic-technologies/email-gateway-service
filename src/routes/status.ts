import { Router, Request, Response } from "express";
import { StatusRequestSchema } from "../schemas";
import type { OrgContext } from "../middleware/requireOrgId";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";

const router = Router();

router.post("/status", async (req: Request, res: Response) => {
  const parsed = StatusRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { campaignId, items } = parsed.data;
  const ctx = res.locals.orgContext as OrgContext;

  // brandIds are forwarded via x-brand-id header by buildServiceHeaders — no need in body
  const payload = { campaignId, items };

  try {
    const [broadcastResult, transactionalResult] = await Promise.allSettled([
      instantlyClient.getStatus(payload, ctx),
      postmarkClient.getStatus(payload, ctx),
    ]);

    const broadcastMap = new Map<string, instantlyClient.StatusResult>();
    if (broadcastResult.status === "fulfilled") {
      for (const r of broadcastResult.value.results) {
        broadcastMap.set(r.email, r);
      }
    } else {
      console.warn(`[email-gateway] instantly-service error: ${broadcastResult.reason}`);
    }

    const transactionalMap = new Map<string, postmarkClient.StatusResult>();
    if (transactionalResult.status === "fulfilled") {
      for (const r of transactionalResult.value.results) {
        transactionalMap.set(r.email, r);
      }
    } else {
      console.warn(`[email-gateway] postmark-service error: ${transactionalResult.reason}`);
    }

    if (broadcastResult.status === "rejected" && transactionalResult.status === "rejected") {
      res.status(502).json({ error: "Both upstream services failed" });
      return;
    }

    const results = items.map((item) => {
      const broadcast = broadcastMap.get(item.email);
      const transactional = transactionalMap.get(item.email);

      // Pick first non-null leadId from either provider
      const leadId = broadcast?.leadId ?? transactional?.leadId ?? null;

      const entry: Record<string, unknown> = {
        leadId,
        email: item.email,
      };

      if (broadcast) {
        entry.broadcast = { campaign: broadcast.campaign, brand: broadcast.brand, global: broadcast.global };
      }

      if (transactional) {
        entry.transactional = { campaign: transactional.campaign, brand: transactional.brand, global: transactional.global };
      }

      return entry;
    });

    res.json({ results });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Failed: ${message}`);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
