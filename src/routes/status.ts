import { Router, Request, Response } from "express";
import { StatusRequestSchema } from "../schemas";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";

const router = Router();

router.post("/status", async (req: Request, res: Response) => {
  const parsed = StatusRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { brandId, campaignId, items } = parsed.data;
  const payload = { brandId, campaignId, items };

  console.log(`[status] brandId=${brandId} campaignId=${campaignId ?? "none"} items=${items.length}`);

  try {
    const [broadcastResult, transactionalResult] = await Promise.allSettled([
      instantlyClient.getStatus(payload),
      postmarkClient.getStatus(payload),
    ]);

    const broadcastMap = new Map<string, instantlyClient.StatusResult>();
    if (broadcastResult.status === "fulfilled") {
      for (const r of broadcastResult.value.results) {
        broadcastMap.set(r.email, r);
      }
    } else {
      console.warn(`[status] instantly-service error: ${broadcastResult.reason}`);
    }

    const transactionalMap = new Map<string, postmarkClient.StatusResult>();
    if (transactionalResult.status === "fulfilled") {
      for (const r of transactionalResult.value.results) {
        transactionalMap.set(r.email, r);
      }
    } else {
      console.warn(`[status] postmark-service error: ${transactionalResult.reason}`);
    }

    if (broadcastResult.status === "rejected" && transactionalResult.status === "rejected") {
      res.status(502).json({ error: "Both upstream services failed" });
      return;
    }

    const results = items.map((item) => {
      const entry: Record<string, unknown> = {
        leadId: item.leadId,
        email: item.email,
      };

      const broadcast = broadcastMap.get(item.email);
      if (broadcast) {
        entry.broadcast = { campaign: broadcast.campaign, brand: broadcast.brand, global: broadcast.global };
      }

      const transactional = transactionalMap.get(item.email);
      if (transactional) {
        entry.transactional = { campaign: transactional.campaign, brand: transactional.brand, global: transactional.global };
      }

      return entry;
    });

    res.json({ results });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[status] Failed: ${message}`);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
