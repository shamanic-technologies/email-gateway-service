import { Router, Request, Response } from "express";
import { z } from "zod";
import { SendCheckRequestSchema } from "../schemas";
import type { OrgContext } from "../middleware/requireOrgId";
import * as instantlyClient from "../lib/instantly-client";
import { resolveFollowUpRoute } from "../lib/follow-up-route";
import { traceEvent } from "../lib/trace-event";

const router = Router();

/**
 * POST /orgs/send-checks (SEND-CHECK-BEFORE-WRITE-1120): what `POST /orgs/send`
 * would refuse for this person, asked BEFORE a script pays its writer.
 *
 * Same route choice as the send (`resolveFollowUpRoute` on a follow-up: a
 * standing refusal before Gmail, a Gmail thread, or instantly-service), then the
 * door's checks on the person on EVERY route (instantly-service owns them: one
 * rule, Gmail included). Every non-2xx of instantly-service is round-tripped
 * verbatim: the caller reads the send's own code.
 */
router.post("/send-checks", async (req: Request, res: Response) => {
  const parsed = SendCheckRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: z.flattenError(parsed.error) });
    return;
  }
  const body = parsed.data;
  const ctx = res.locals.orgContext as OrgContext;

  try {
    let transport: "instantly" | "gmail" = "instantly";
    if (body.followUp === true) {
      const route = await resolveFollowUpRoute(body.to, ctx);
      if (route.transport === "refused") {
        traceEvent(ctx, "send-check.refused", `to=${body.to} code=${String(route.body.code)} route=follow-up`);
        res.status(route.status).json(route.body);
        return;
      }
      transport = route.transport;
    }
    const pass = await instantlyClient.sendChecks(body.to, ctx, { maxVerdictAgeDays: body.maxVerdictAgeDays });
    traceEvent(ctx, "send-check.ok", `to=${body.to} transport=${transport} verdict=${pass.verdict ?? "none"} reused=${String(pass.reused)}`);
    res.json({ sendable: true, transport, to: body.to, verdict: pass.verdict, reused: pass.reused, verifiedAt: pass.verifiedAt });
  } catch (error: unknown) {
    if (error instanceof instantlyClient.InstantlyHttpError) {
      let refusal: Record<string, unknown>;
      try {
        const p: unknown = JSON.parse(error.bodyText);
        refusal = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : { error: error.bodyText };
      } catch {
        refusal = { error: error.bodyText || "Refused by instantly-service" };
      }
      const code = typeof refusal.code === "string" ? refusal.code : "none";
      console.warn(`[email-gateway] send-check refused: status=${error.status} code=${code} to=${body.to}`);
      traceEvent(ctx, "send-check.refused", `to=${body.to} status=${error.status} code=${code}`);
      res.status(error.status).json(refusal);
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] send-check failed for ${body.to}: ${message}`);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
