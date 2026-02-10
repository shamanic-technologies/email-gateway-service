import { Router, Request, Response } from "express";
import { SendRequestSchema } from "../schemas";
import { config } from "../config";
import * as postmarkClient from "../lib/postmark-client";
import * as instantlyClient from "../lib/instantly-client";

const router = Router();

router.post("/send", async (req: Request, res: Response) => {
  const parsed = SendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const body = parsed.data;

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
        htmlBody: body.htmlBody,
        textBody: body.textBody,
        replyTo: body.replyTo,
        tag: body.tag,
        metadata: body.metadata,
      });

      res.json({ success: true, provider: "transactional", messageId: result.messageId });
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
          body: body.htmlBody || body.textBody || "",
        },
      });

      if (result.added === 0) {
        res.status(409).json({
          success: false,
          provider: "broadcast",
          error: "Lead was not added to campaign (possibly duplicate)",
          campaignId: result.campaignId,
        });
        return;
      }

      res.json({
        success: true,
        provider: "broadcast",
        messageId: result.leadId ?? undefined,
        campaignId: result.campaignId,
      });
      return;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[send] Failed: ${message}`);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
