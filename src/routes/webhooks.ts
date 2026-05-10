import { Router, Request, Response } from "express";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import { dispatchInbound } from "../lib/inbound-forwarder";
import { config } from "../config";

const router = Router();

router.post("/postmark", async (req: Request, res: Response) => {
  let result: unknown;
  try {
    result = await postmarkClient.forwardWebhook(req.body);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Failed: ${message}`);
    res.status(502).json({ error: message });
    return;
  }

  await dispatchInbound(req.body, config.inboundForwarding?.rules ?? []);
  res.json(result);
});

router.post("/instantly", async (req: Request, res: Response) => {
  try {
    const result = await instantlyClient.forwardWebhook(req.body);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Failed: ${message}`);
    res.status(502).json({ error: message });
  }
});

export default router;
