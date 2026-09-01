import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  PostOptOutRequestSchema,
  PostOptOutWithdrawalRequestSchema,
  GetOptOutsQuerySchema,
} from "../schemas";
import type { OrgContext } from "../middleware/requireOrgId";
import { instantlyPassthrough } from "../lib/instantly-passthrough";
import { traceEvent } from "../lib/trace-event";

const router = Router();

const UPSTREAM_PATH = "/orgs/opt-outs";
const UPSTREAM_WITHDRAWALS_PATH = "/orgs/opt-outs/withdrawals";

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

router.post("/opt-outs", async (req: Request, res: Response) => {
  const parsed = PostOptOutRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: z.flattenError(parsed.error) });
    return;
  }

  const ctx = res.locals.orgContext as OrgContext;
  const body = parsed.data;

  traceEvent(ctx, "opt-outs.post.start", `email=${body.email} channel=${body.channel}`);

  try {
    const upstream = await instantlyPassthrough(UPSTREAM_PATH, {
      method: "POST",
      body,
      ctx,
    });

    if (upstream.status >= 500) {
      console.error(
        `[email-gateway] opt-outs POST upstream ${upstream.status}: ${upstream.bodyText.slice(0, 500)}`,
      );
      traceEvent(ctx, "opt-outs.post.error", `upstream=${upstream.status}`);
      res.status(502).json({ error: "Upstream service error", details: upstream.bodyText });
      return;
    }

    const parsedBody = parseUpstreamBody(upstream.bodyText, upstream.contentType);
    traceEvent(ctx, "opt-outs.post.done", `status=${upstream.status}`);
    res.status(upstream.status).json(parsedBody);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] opt-outs POST failed: ${message}`);
    traceEvent(ctx, "opt-outs.post.error", message);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

router.post("/opt-outs/withdrawals", async (req: Request, res: Response) => {
  const parsed = PostOptOutWithdrawalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: z.flattenError(parsed.error) });
    return;
  }

  const ctx = res.locals.orgContext as OrgContext;
  const body = parsed.data;

  traceEvent(ctx, "opt-outs.withdrawal.post.start", `email=${body.email}`);

  try {
    const upstream = await instantlyPassthrough(UPSTREAM_WITHDRAWALS_PATH, {
      method: "POST",
      body,
      ctx,
    });

    if (upstream.status >= 500) {
      console.error(
        `[email-gateway] opt-outs withdrawal POST upstream ${upstream.status}: ${upstream.bodyText.slice(0, 500)}`,
      );
      traceEvent(ctx, "opt-outs.withdrawal.post.error", `upstream=${upstream.status}`);
      res.status(502).json({ error: "Upstream service error", details: upstream.bodyText });
      return;
    }

    const parsedBody = parseUpstreamBody(upstream.bodyText, upstream.contentType);
    traceEvent(ctx, "opt-outs.withdrawal.post.done", `status=${upstream.status}`);
    res.status(upstream.status).json(parsedBody);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] opt-outs withdrawal POST failed: ${message}`);
    traceEvent(ctx, "opt-outs.withdrawal.post.error", message);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

router.get("/opt-outs", async (req: Request, res: Response) => {
  const parsed = GetOptOutsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: z.flattenError(parsed.error) });
    return;
  }

  const ctx = res.locals.orgContext as OrgContext;
  const filters = parsed.data;

  const params = new URLSearchParams();
  if (filters.email) params.set("email", filters.email);
  if (filters.standing_only) params.set("standing_only", filters.standing_only);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const path = qs ? `${UPSTREAM_PATH}?${qs}` : UPSTREAM_PATH;

  traceEvent(
    ctx,
    "opt-outs.get.start",
    `email=${filters.email ?? "none"} standing_only=${filters.standing_only ?? "none"}`,
  );

  try {
    const upstream = await instantlyPassthrough(path, { method: "GET", ctx });

    if (upstream.status >= 500) {
      console.error(
        `[email-gateway] opt-outs GET upstream ${upstream.status}: ${upstream.bodyText.slice(0, 500)}`,
      );
      traceEvent(ctx, "opt-outs.get.error", `upstream=${upstream.status}`);
      res.status(502).json({ error: "Upstream service error", details: upstream.bodyText });
      return;
    }

    const parsedBody = parseUpstreamBody(upstream.bodyText, upstream.contentType);
    traceEvent(ctx, "opt-outs.get.done", `status=${upstream.status}`);
    res.status(upstream.status).json(parsedBody);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[email-gateway] opt-outs GET failed: ${message}`);
    traceEvent(ctx, "opt-outs.get.error", message);
    res.status(502).json({ error: "Upstream service error", details: message });
  }
});

export default router;
