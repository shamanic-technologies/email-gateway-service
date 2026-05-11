import { Router, Request, Response } from "express";
import { dispatchInbound, SubscriberDeliveryError } from "../lib/inbound-forwarder";
import { config } from "../config";

const router = Router();

router.post("/postmark", async (req: Request, res: Response) => {
  try {
    await dispatchInbound(req.body, config.inboundSubscriptions);
  } catch (err: unknown) {
    if (err instanceof SubscriberDeliveryError) {
      console.error(
        `[email-gateway] inbound-dispatch failed subscription=${err.subscription} status=${err.status ?? "n/a"} error=${err.message}`
      );
      res.status(502).json({
        error: "subscriber delivery failed",
        subscription: err.subscription,
        upstream_status: err.status ?? null,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[email-gateway] inbound-dispatch error: ${msg}`);
    res.status(500).json({ error: msg });
    return;
  }
  res.json({ ok: true });
});

export default router;
