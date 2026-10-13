import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  PlatformSendRequestSchema,
  PLATFORM_SEND_TRANSACTIONAL_ONLY,
  PLATFORM_SEND_ORG_IDENTITY_REFUSED,
} from "../schemas";
import * as postmarkClient from "../lib/postmark-client";
import * as idempotencyStore from "../lib/idempotency-store";

/**
 * POST /platform/send — ONE transactional email with NO organisation and NO
 * user, paid by the platform (e.g. the 6-digit sign-up code client-service
 * mails before any org exists). Relayed to postmark-service's org-less
 * platform-paid send. Only Postmark may send org-less: broadcast (Instantly)
 * is refused with a named 400, and so is any org/user identity header, so an
 * org-bearing caller can never land here by accident and dodge its own bill.
 */
const router = Router();

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

router.post("/send", async (req: Request, res: Response) => {
  if (req.body?.type !== "transactional") {
    console.warn(`[email-gateway] platform-send refused: type=${req.body?.type ?? "none"}`);
    res.status(400).json({
      error: "An org-less platform send is transactional (Postmark) only",
      code: PLATFORM_SEND_TRANSACTIONAL_ONLY,
    });
    return;
  }

  if (headerString(req.headers["x-org-id"]) || headerString(req.headers["x-user-id"])) {
    console.warn("[email-gateway] platform-send refused: org/user identity header present");
    res.status(400).json({
      error: "An org-less platform send carries no x-org-id or x-user-id; use POST /orgs/send for an org-bearing send",
      code: PLATFORM_SEND_ORG_IDENTITY_REFUSED,
    });
    return;
  }

  const parsed = PlatformSendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: z.flattenError(parsed.error) });
    return;
  }
  const body = parsed.data;

  if (body.idempotencyKey) {
    let cached: idempotencyStore.StoredEntry | undefined;
    try {
      cached = await idempotencyStore.get(body.idempotencyKey);
    } catch (error: unknown) {
      // Cannot tell whether this key already sent: refuse rather than risk a
      // second email. The caller retries; nothing went out.
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[email-gateway] platform-send idempotency read failed key=${body.idempotencyKey}: ${message}`);
      res.status(502).json({ error: "Idempotency store unavailable", details: message });
      return;
    }
    if (cached) {
      console.log(`[email-gateway] platform-send idempotency hit key=${body.idempotencyKey}`);
      res.status(cached.statusCode).json({ ...cached.response, deduplicated: true });
      return;
    }
  }

  const runId = headerString(req.headers["x-run-id"]);
  const metadata = body.metadata && Object.keys(body.metadata).length > 0 ? body.metadata : undefined;
  console.log(`[email-gateway] platform-send to=${body.to} tag=${body.tag ?? "none"} runId=${runId ?? "none"}`);

  try {
    const result = await postmarkClient.sendPlatformEmail(
      {
        to: body.to,
        subject: body.subject,
        htmlBody: body.htmlBody,
        textBody: body.textBody,
        from: body.from,
        replyTo: body.replyTo,
        tag: body.tag,
        metadata,
      },
      {
        runId,
        workflowSlug: headerString(req.headers["x-workflow-slug"]),
        featureSlug: headerString(req.headers["x-feature-slug"]),
      },
    );
    if (!result.messageId) {
      throw new Error("postmark-service answered without a messageId");
    }
    const response = {
      success: true as const,
      provider: "transactional" as const,
      payer: "platform" as const,
      messageId: result.messageId,
      ...(result.runId ? { runId: result.runId } : {}),
    };
    if (body.idempotencyKey) await idempotencyStore.remember(body.idempotencyKey, 200, response);
    console.log(`[email-gateway] platform-send ok messageId=${result.messageId}`);
    res.json(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] platform-send failed: ${message}`);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
