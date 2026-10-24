import { Router, Request, Response } from "express";
import { z } from "zod";
import { SendRequestSchema } from "../schemas";
import type { OrgContext } from "../middleware/requireOrgId";

import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";
import { appendSignature } from "../lib/signature";
import * as idempotencyStore from "../lib/idempotency-store";
import { traceEvent } from "../lib/trace-event";
import { resolveFollowUpRoute } from "../lib/follow-up-route";
import * as googleClient from "../lib/google-client";

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
    let cached: idempotencyStore.StoredEntry | undefined;
    try {
      cached = await idempotencyStore.get(body.idempotencyKey);
    } catch (error: unknown) {
      // Cannot tell whether this key already sent: refuse rather than risk a
      // second email. The caller retries; nothing went out.
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[email-gateway] send idempotency read failed key=${body.idempotencyKey}: ${message}`);
      res.status(502).json({ error: "Idempotency store unavailable", details: message });
      return;
    }
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
        // Absent = no `payer` key on the wire: postmark-service decides as before.
        ...(body.payer ? { payer: body.payer } : {}),
        // Cost accounting: the person this send reaches + what it consumed for
        // them. Absent = no key on the wire, byte-identical to before.
        ...(body.outcomeSubject ? { outcomeSubject: body.outcomeSubject } : {}),
        ...(body.consumedOutcomeKeys ? { consumedOutcomeKeys: body.consumedOutcomeKeys } : {}),
      }, ctx);

      console.log(`[email-gateway] postmark response: messageId=${result.messageId}`);
      traceEvent(ctx, "send.transactional.ok", `messageId=${result.messageId} to=${body.to}`);
      const response = { success: true, provider: "transactional" as const, messageId: result.messageId };
      if (body.idempotencyKey) {
        await idempotencyStore.remember(body.idempotencyKey, 200, response);
      }
      res.json(response);
      return;
    }

    if (body.type === "broadcast" && body.followUp === true) {
      // A follow-up lands in the thread the person wrote in last, from the
      // address they wrote to (RIGHT-MOMENT-OR-LATER-1014). When that thread is
      // in a Gmail mailbox the org connected, google-service replies in it;
      // otherwise instantly-service continues its own thread, as before.
      const route = await resolveFollowUpRoute(body.to, ctx);
      traceEvent(
        ctx,
        "send.follow-up.route",
        `to=${body.to} transport=${route.transport}${route.transport === "instantly" ? ` reason=${route.reason}` : ""}${route.transport === "gmail" ? ` thread=${route.thread.threadId} from=${route.thread.fromAddress}` : ""}`,
      );
      if (route.transport === "refused") {
        console.warn(`[email-gateway] follow-up refused before Gmail: code=${String(route.body.code)} to=${body.to}`);
        res.status(route.status).json(route.body);
        return;
      }
      if (route.transport === "gmail") {
        if (body.sequence.length !== 1) {
          res.status(422).json({
            error: "A follow-up answered in a Gmail thread is ONE email",
            code: "follow_up_gmail_single_email",
            details: `${body.to}'s latest exchange is in a Gmail thread; a ${body.sequence.length}-step sequence cannot be sent there. Nothing was sent.`,
          });
          return;
        }
        const step = body.sequence[0];
        const sent = await googleClient.replyInGmailThread(
          {
            to: body.to,
            threadId: route.thread.threadId,
            bodyHtml: step.bodyHtml,
            ...(step.bodyText ? { bodyText: step.bodyText } : {}),
            // google-service declares the reply as this lead's message_sent in
            // runs-service's ledger; absent = sent but undeclared, never guessed.
            ...(body.leadId ? { leadId: body.leadId } : {}),
          },
          ctx,
        );
        console.log(`[email-gateway] gmail thread reply: thread=${sent.threadId} from=${sent.from} to=${sent.to} message=${sent.gmailMessageId}`);
        traceEvent(ctx, "send.broadcast.gmail.ok", `thread=${sent.threadId} from=${sent.from} message=${sent.gmailMessageId}`);
        const response = {
          success: true,
          provider: "broadcast" as const,
          transport: "gmail" as const,
          messageId: sent.gmailMessageId,
          threadId: sent.threadId,
          from: sent.from,
        };
        if (body.idempotencyKey) {
          await idempotencyStore.remember(body.idempotencyKey, 200, response);
        }
        res.json(response);
        return;
      }
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
        // A follow-up of the brand's own outreach: instantly-service's contract.
        ...(body.followUp === true ? { followUp: true } : {}),
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
          await idempotencyStore.remember(body.idempotencyKey, 200, response);
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
        await idempotencyStore.remember(body.idempotencyKey, 200, response);
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
    // google-service's named refusals (no send permission, thread gone, From
    // not a send-as) come back the same way: status + body, nothing sent.
    if (
      error instanceof googleClient.GoogleHttpError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      const refusal = parseRefusalBody(error.bodyText);
      const code = typeof refusal.code === "string" ? refusal.code : "none";
      console.warn(`[email-gateway] Refused by google-service: status=${error.status} code=${code} to=${body.to}`);
      traceEvent(ctx, "send.refused", `type=${body.type} to=${body.to} status=${error.status} code=${code} transport=gmail`);
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
