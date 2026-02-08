import { Router, Request, Response } from "express";
import { SendRequestSchema } from "../schemas";
import { config } from "../config";
import { resolveOrganization, resolveUser } from "../lib/org-resolver";
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
    // Resolve org (upsert)
    const org = await resolveOrganization(body.clerkOrgId, body.appId);

    // Resolve user if provided
    if (body.clerkUserId) {
      await resolveUser(body.clerkUserId, org.id);
    }

    if (body.type === "transactional") {
      const result = await postmarkClient.sendEmail({
        orgId: org.id,
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

      res.json({ success: true, provider: "transactional", data: result });
      return;
    }

    if (body.type === "broadcast") {
      const result = await instantlyClient.atomicSend({
        orgId: org.id,
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

      res.json({ success: true, provider: "broadcast", data: result });
      return;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[send] Failed: ${message}`);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
