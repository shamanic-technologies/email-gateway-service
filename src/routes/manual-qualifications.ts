import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  PostManualQualificationRequestSchema,
  GetManualQualificationsQuerySchema,
} from "../schemas";
import type { OrgContext } from "../middleware/requireOrgId";
import { instantlyPassthrough } from "../lib/instantly-passthrough";
import { traceEvent } from "../lib/trace-event";

const router = Router();

const UPSTREAM_PATH = "/orgs/manual-qualifications";

function parseUpstreamBody(bodyText: string, contentType: string | null): unknown {
  if (!bodyText) return null;
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(bodyText);
    } catch {
      return { error: "Upstream returned invalid JSON", details: bodyText };
    }
  }
  return { error: bodyText };
}

router.post("/manual-qualifications", async (req: Request, res: Response) => {
  const parsed = PostManualQualificationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: z.flattenError(parsed.error) });
    return;
  }

  const ctx = res.locals.orgContext as OrgContext;
  const body = parsed.data;

  traceEvent(
    ctx,
    "manual-qualifications.post.start",
    `campaign=${body.campaign_id} email=${body.email} status=${body.status}`,
  );

  try {
    const upstream = await instantlyPassthrough(UPSTREAM_PATH, {
      method: "POST",
      body,
      ctx,
    });

    if (upstream.status >= 500) {
      console.error(
        `[email-gateway] manual-qualifications POST upstream ${upstream.status}: ${upstream.bodyText.slice(0, 500)}`,
      );
      traceEvent(ctx, "manual-qualifications.post.error", `upstream=${upstream.status}`);
      res.status(502).json({ error: "Upstream service error", details: upstream.bodyText });
      return;
    }

    const parsedBody = parseUpstreamBody(upstream.bodyText, upstream.contentType);
    traceEvent(ctx, "manual-qualifications.post.done", `status=${upstream.status}`);
    res.status(upstream.status).json(parsedBody);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] manual-qualifications POST failed: ${message}`);
    traceEvent(ctx, "manual-qualifications.post.error", message);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

router.get("/manual-qualifications", async (req: Request, res: Response) => {
  const parsed = GetManualQualificationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: z.flattenError(parsed.error) });
    return;
  }

  const ctx = res.locals.orgContext as OrgContext;
  const filters = parsed.data;

  const params = new URLSearchParams();
  if (filters.campaign_id) params.set("campaign_id", filters.campaign_id);
  if (filters.email) params.set("email", filters.email);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const path = qs ? `${UPSTREAM_PATH}?${qs}` : UPSTREAM_PATH;

  traceEvent(
    ctx,
    "manual-qualifications.get.start",
    `campaign=${filters.campaign_id ?? "none"} email=${filters.email ?? "none"}`,
  );

  try {
    const upstream = await instantlyPassthrough(path, { method: "GET", ctx });

    if (upstream.status >= 500) {
      console.error(
        `[email-gateway] manual-qualifications GET upstream ${upstream.status}: ${upstream.bodyText.slice(0, 500)}`,
      );
      traceEvent(ctx, "manual-qualifications.get.error", `upstream=${upstream.status}`);
      res.status(502).json({ error: "Upstream service error", details: upstream.bodyText });
      return;
    }

    const parsedBody = parseUpstreamBody(upstream.bodyText, upstream.contentType);
    traceEvent(ctx, "manual-qualifications.get.done", `status=${upstream.status}`);
    res.status(upstream.status).json(parsedBody);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] manual-qualifications GET failed: ${message}`);
    traceEvent(ctx, "manual-qualifications.get.error", message);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
