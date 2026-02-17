import { Router, Request, Response } from "express";
import { SendRequestSchema } from "../schemas";
import { config } from "../config";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import * as brandClient from "../lib/brand-client";
import { appendSignature } from "../lib/signature";
import * as idempotencyStore from "../lib/idempotency-store";

const router = Router();

router.post("/send", async (req: Request, res: Response) => {
  const parsed = SendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const body = parsed.data;

  // Idempotency check — return cached result if key was already processed
  if (body.idempotencyKey) {
    const cached = idempotencyStore.get(body.idempotencyKey);
    if (cached) {
      console.log(`[send] idempotency hit key=${body.idempotencyKey} to=${body.to}`);
      res.status(cached.statusCode).json({ ...cached.response, deduplicated: true });
      return;
    }
  }

  let brandUrl: string | undefined;
  if (body.brandId) {
    try {
      const brand = await brandClient.getBrand(body.brandId);
      brandUrl = brand.brandUrl ?? undefined;
    } catch (err) {
      console.warn(`[send] failed to fetch brand ${body.brandId}, signature will use fallback`);
    }
  }

  const htmlWithSignature = appendSignature(body.htmlBody, body.type, body.appId, brandUrl);

  console.log(`[send] type=${body.type} to=${body.to} campaign=${body.campaignId} run=${body.runId}`);

  try {
    if (body.type === "transactional") {
      const result = await postmarkClient.sendEmail({
        orgId: body.clerkOrgId,
        runId: body.runId,
        brandId: body.brandId,
        appId: body.appId,
        campaignId: body.campaignId,
        from: config.emailFromAddress,
        to: body.to,
        subject: body.subject,
        htmlBody: htmlWithSignature,
        textBody: body.textBody,
        replyTo: body.replyTo,
        tag: body.tag,
        metadata: body.metadata,
      });

      console.log(`[send] postmark response: messageId=${result.messageId}`);
      const response = { success: true, provider: "transactional" as const, messageId: result.messageId };
      if (body.idempotencyKey) {
        idempotencyStore.set(body.idempotencyKey, 200, response);
      }
      res.json(response);
      return;
    }

    if (body.type === "broadcast") {
      const result = await instantlyClient.atomicSend({
        orgId: body.clerkOrgId,
        runId: body.runId,
        brandId: body.brandId,
        appId: body.appId,
        campaignId: body.campaignId,
        to: body.to,
        firstName: body.recipientFirstName,
        lastName: body.recipientLastName,
        company: body.recipientCompany,
        variables: body.metadata,
        email: {
          subject: body.subject,
          body: htmlWithSignature || body.textBody || "",
        },
      });

      console.log(`[send] instantly response: campaignId=${result.campaignId} leadId=${result.leadId} added=${result.added}`);

      if (result.added === 0) {
        console.warn(`[send] lead not added to=${body.to} campaign=${result.campaignId}`);
        const response = {
          success: false,
          provider: "broadcast" as const,
          error: "Lead was not added to campaign (possibly duplicate)",
          campaignId: result.campaignId,
        };
        if (body.idempotencyKey) {
          idempotencyStore.set(body.idempotencyKey, 409, response);
        }
        res.status(409).json(response);
        return;
      }

      const response = {
        success: true,
        provider: "broadcast" as const,
        messageId: result.leadId ?? undefined,
        campaignId: result.campaignId,
      };
      if (body.idempotencyKey) {
        idempotencyStore.set(body.idempotencyKey, 200, response);
      }
      res.json(response);
      return;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[send] Failed: ${message}`);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
