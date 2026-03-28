import { Request, Response, NextFunction } from "express";

export interface TrackingHeaders {
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

export function extractTrackingHeaders(req: Request): TrackingHeaders {
  const headers: TrackingHeaders = {};
  const campaignId = req.headers["x-campaign-id"];
  if (typeof campaignId === "string") headers.campaignId = campaignId;
  const brandId = req.headers["x-brand-id"];
  if (typeof brandId === "string") headers.brandId = brandId;
  const workflowSlug = req.headers["x-workflow-slug"];
  if (typeof workflowSlug === "string") headers.workflowSlug = workflowSlug;
  const featureSlug = req.headers["x-feature-slug"];
  if (typeof featureSlug === "string") headers.featureSlug = featureSlug;
  return headers;
}

export function requireIdentityHeaders(req: Request, res: Response, next: NextFunction) {
  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];
  const runId = req.headers["x-run-id"];

  if (!orgId || typeof orgId !== "string") {
    res.status(400).json({ error: "Missing required header: x-org-id" });
    return;
  }

  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: "Missing required header: x-user-id" });
    return;
  }

  if (!runId || typeof runId !== "string") {
    res.status(400).json({ error: "Missing required header: x-run-id" });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;
  res.locals.runId = runId;

  const tracking = extractTrackingHeaders(req);
  res.locals.trackingHeaders = tracking;

  next();
}
