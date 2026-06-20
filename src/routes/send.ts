import { Router, Request, Response } from "express";
import { z } from "zod";
import { SendRequestSchema } from "../schemas";
import type { OrgContext } from "../middleware/requireOrgId";

import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import { appendSignature } from "../lib/signature";
import * as idempotencyStore from "../lib/idempotency-store";
import { traceEvent } from "../lib/trace-event";

const router = Router();

type AttributionContext = {
  customerProfileId?: string;
};

function resolveAttribution(body: { customerProfileId?: string }, ctx: OrgContext): AttributionContext {
  return {
    customerProfileId: body.customerProfileId ?? ctx.customerProfileId,
  };
}

function mergeAttributionMetadata(
  metadata: Record<string, string> | undefined,
  attribution: AttributionContext,
): Record<string, string> | undefined {
  const merged: Record<string, string> = { ...(metadata ?? {}) };
  if (attribution.customerProfileId) merged.customerProfileId = attribution.customerProfileId;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

router.post("/send", async (req: Request, res: Response) => {
  const parsed = SendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    const missingFields = Object.keys(flat.fieldErrors);
    console.error(
      `[email-gateway] Validation failed: missing/invalid fields=[${missingFields.join(", ")}]` +
      ` type=${req.body?.type} to=${req.body?.to ?? "NULL"} leadId=${req.body?.leadId ?? "none"}` +
      ` campaignId=${req.body?.campaignId ?? "none"}`
    );
    res.status(400).json({ error: "Invalid request", details: flat });
    return;
  }

  const body = parsed.data;
  const ctx = res.locals.orgContext as OrgContext;

  // Idempotency check — return cached result if key was already processed
  if (body.idempotencyKey) {
    const cached = idempotencyStore.get(body.idempotencyKey);
    if (cached) {
      console.log(`[email-gateway] idempotency hit key=${body.idempotencyKey} to=${body.to}`);
      traceEvent(ctx, "send.idempotency-hit", `key=${body.idempotencyKey} to=${body.to}`);
      res.status(cached.statusCode).json({ ...cached.response, deduplicated: true });
      return;
    }
  }

  // Use context headers as fallbacks for body fields the LLM may have omitted
  const effectiveCampaignId = body.campaignId ?? ctx.campaignId;
  const effectiveWorkflowName = body.workflowSlug ?? ctx.workflowSlug;
  const attribution = resolveAttribution(body, ctx);
  const metadataWithAttribution = mergeAttributionMetadata(body.metadata, attribution);

  console.log(`[email-gateway] type=${body.type} to=${body.to} campaign=${effectiveCampaignId} runId=${ctx.runId} workflow=${effectiveWorkflowName}`);

  traceEvent(ctx, "send.start", `type=${body.type} to=${body.to} campaign=${effectiveCampaignId ?? "none"}`);

  try {
    if (body.type === "transactional") {
      const htmlWithSignature = appendSignature(body.htmlBody, body.type);

      const result = await postmarkClient.sendEmail({
        orgId: ctx.orgId,
        userId: ctx.userId,
        runId: ctx.runId,
        leadId: body.leadId,
        workflowSlug: effectiveWorkflowName,
        campaignId: effectiveCampaignId,
        from: body.from,
        to: body.to,
        bcc: body.bcc,
        subject: body.subject,
        htmlBody: htmlWithSignature,
        textBody: body.textBody,
        replyTo: body.replyTo,
        tag: body.tag,
        metadata: metadataWithAttribution,
        inReplyTo: body.inReplyTo,
        references: body.references,
        messageStream: body.messageStream,
      }, ctx);

      console.log(`[email-gateway] postmark response: messageId=${result.messageId}`);
      traceEvent(ctx, "send.transactional.ok", `messageId=${result.messageId} to=${body.to}`);
      const response = { success: true, provider: "transactional" as const, messageId: result.messageId };
      if (body.idempotencyKey) {
        idempotencyStore.set(body.idempotencyKey, 200, response);
      }
      res.json(response);
      return;
    }

    if (body.type === "broadcast") {
      const result = await instantlyClient.atomicSend({
        leadId: body.leadId,
        to: body.to,
        firstName: body.recipientFirstName,
        lastName: body.recipientLastName,
        company: body.recipientCompany,
        variables: metadataWithAttribution,
        subject: body.subject,
        sequence: body.sequence,
      }, ctx);

      console.log(`[email-gateway] instantly response: campaignId=${result.campaignId} leadId=${result.leadId} added=${result.added}`);
      traceEvent(ctx, "send.broadcast.ok", `campaignId=${result.campaignId} leadId=${result.leadId} added=${result.added}`);

      if (result.added === 0) {
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
    console.error(`[email-gateway] Failed: ${message}`);
    traceEvent(ctx, "send.error", `type=${body.type} to=${body.to} error=${message}`);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
