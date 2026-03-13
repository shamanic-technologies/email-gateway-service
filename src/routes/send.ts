import { Router, Request, Response } from "express";
import { SendRequestSchema } from "../schemas";
import { TrackingHeaders } from "../middleware/identityHeaders";

import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import * as brandClient from "../lib/brand-client";
import { appendSignature } from "../lib/signature";
import * as idempotencyStore from "../lib/idempotency-store";

const router = Router();

router.post("/send", async (req: Request, res: Response) => {
  const parsed = SendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const missingFields = Object.keys(flat.fieldErrors);
    console.error(
      `[send] Validation failed: missing/invalid fields=[${missingFields.join(", ")}]` +
      ` type=${req.body?.type} to=${req.body?.to ?? "NULL"} leadId=${req.body?.leadId ?? "none"}` +
      ` campaignId=${req.body?.campaignId ?? "none"}`
    );
    res.status(400).json({ error: "Invalid request", details: flat });
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

  const { orgId, userId, runId, trackingHeaders: th } = res.locals as {
    orgId: string; userId: string; runId: string; trackingHeaders: TrackingHeaders;
  };
  const identityHeaders = { orgId, userId, runId };
  const trackingHeaders: TrackingHeaders = th ?? {};

  // Use tracking headers as fallbacks for body fields the LLM may have omitted
  const effectiveCampaignId = body.campaignId ?? trackingHeaders.campaignId;
  const effectiveBrandId = body.brandId ?? trackingHeaders.brandId;
  const effectiveWorkflowName = body.workflowName ?? trackingHeaders.workflowName;

  console.log(`[send] type=${body.type} to=${body.to} campaign=${effectiveCampaignId} runId=${runId} workflow=${effectiveWorkflowName}`);

  try {
    if (body.type === "transactional") {
      let brandUrl: string | undefined;
      if (effectiveBrandId) {
        try {
          const brand = await brandClient.getBrand(effectiveBrandId, identityHeaders, trackingHeaders);
          brandUrl = brand.brandUrl ?? undefined;
        } catch (err) {
          console.warn(`[send] failed to fetch brand ${effectiveBrandId}, signature will use fallback`);
        }
      }

      const htmlWithSignature = appendSignature(body.htmlBody, body.type);

      const result = await postmarkClient.sendEmail({
        orgId,
        userId,
        runId,
        brandId: effectiveBrandId,
        leadId: body.leadId,
        workflowName: effectiveWorkflowName,
        campaignId: effectiveCampaignId,
        from: body.from,
        to: body.to,
        subject: body.subject,
        htmlBody: htmlWithSignature,
        textBody: body.textBody,
        replyTo: body.replyTo,
        tag: body.tag,
        metadata: body.metadata,
      }, identityHeaders, trackingHeaders);

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
        orgId,
        userId,
        runId,
        brandId: effectiveBrandId,
        leadId: body.leadId,
        workflowName: effectiveWorkflowName,
        campaignId: effectiveCampaignId,
        to: body.to,
        firstName: body.recipientFirstName,
        lastName: body.recipientLastName,
        company: body.recipientCompany,
        variables: body.metadata,
        subject: body.subject,
        sequence: body.sequence,
      }, identityHeaders, trackingHeaders);

      console.log(`[send] instantly response: campaignId=${result.campaignId} leadId=${result.leadId} added=${result.added}`);

      if (result.added === 0) {
        console.log(`[send] lead already in campaign to=${body.to} campaign=${result.campaignId} — returning 200 (idempotent)`);
        const response = {
          success: true,
          provider: "broadcast" as const,
          campaignId: result.campaignId,
          deduplicated: true,
        };
        if (body.idempotencyKey) {
          idempotencyStore.set(body.idempotencyKey, 200, response);
        }
        res.json(response);
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
