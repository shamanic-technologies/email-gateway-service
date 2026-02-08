import { Router, Request, Response } from "express";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";

const router = Router();

router.post("/postmark", async (req: Request, res: Response) => {
  try {
    const result = await postmarkClient.forwardWebhook(req.body);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[webhooks/postmark] Failed: ${message}`);
    res.status(502).json({ error: message });
  }
});

router.post("/instantly", async (req: Request, res: Response) => {
  try {
    const result = await instantlyClient.forwardWebhook(req.body);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[webhooks/instantly] Failed: ${message}`);
    res.status(502).json({ error: message });
  }
});

export default router;
