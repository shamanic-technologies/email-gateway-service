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
  const metadata = body.metadata && Object.keys(body.metadata).length > 0 ? body.metadata : undefined;

  console.log(`[email-gateway] type=${body.type} to=${body.to} campaign=${effectiveCampaignId} runId=${ctx.runId} workflow=${effectiveWorkflowName}`);

  traceEvent(ctx, "send.start", `type=${body.type} to=${body.to} campaign=${effectiveCampaignId ?? "none"}`);

  try {
    if (body.type === "transactional") {
      const htmlWithSignature = appendSignature(body.htmlBody, body.type, body.stream === "transactional");

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
        cc: body.cc,
        subject: body.subject,
        htmlBody: htmlWithSignature,
        textBody: body.textBody,
        replyTo: body.replyTo,
        tag: body.tag,
        metadata,
        inReplyTo: body.inReplyTo,
        references: body.references,
        messageStream: body.messageStream,
        stream: body.stream,
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
      const bccList = body.bcc
        ? body.bcc.split(",").map((e) => e.trim()).filter((e) => e.length > 0)
        : [];

      const result = await instantlyClient.atomicSend({
        leadId: body.leadId,
        to: body.to,
        firstName: body.recipientFirstName,
        lastName: body.recipientLastName,
        company: body.recipientCompany,
        variables: metadata,
        bcc: bccList.length > 0 ? bccList : undefined,
        subject: body.subject,
        // Explicit null means "the lead has no known timezone" — same as absent.
        // Omit the field so instantly-service applies its own default timezone.
        timezone: body.timezone ?? undefined,
        sequence: body.sequence,
      }, ctx, body.idempotencyKey);

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
    // A 4xx from instantly-service is the SENDER'S ANSWER about this lead, not
    // an outage: 409 `recent_brand_contact` (3-month per-brand re-contact
    // window), 409 `lead_opted_out`, 409 `lead_not_a_prospect`, 402
    // `insufficient_credits`, 400/422. Nothing was sent and nothing was billed.
    // Round-trip it byte-equal (status + body, `code` included) so a caller can
    // skip the lead and move on. Flattening it into a 502 made every workflow
    // read a refusal as a broken sender, fail the run, and get the same lead
    // re-served next run, forever (RECONTACT-LOOP-1011). 5xx and network
    // failures stay a 502. Not cached under the idempotency key: the refusal
    // is the sender's to repeat, and a retry asks it again.
    if (
      error instanceof instantlyClient.InstantlyHttpError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      const refusal = parseRefusalBody(error.bodyText);
      const code = typeof refusal.code === "string" ? refusal.code : "none";
      console.warn(`[email-gateway] Refused by instantly-service: status=${error.status} code=${code} to=${body.to}`);
      traceEvent(ctx, "send.refused", `type=${body.type} to=${body.to} status=${error.status} code=${code}`);
      res.status(error.status).json(refusal);
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] Failed: ${message}`);
    traceEvent(ctx, "send.error", `type=${body.type} to=${body.to} error=${message}`);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

/**
 * instantly-service answers its refusals in JSON. A non-JSON 4xx body (a proxy
 * page, an empty body) is still a 4xx, so it is wrapped rather than dropped.
 */
function parseRefusalBody(bodyText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON: wrapped below
  }
  return { error: bodyText || "Refused by instantly-service" };
}

export default router;
