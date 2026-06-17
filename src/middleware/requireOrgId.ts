import { Request, Response, NextFunction } from "express";

export interface OrgContext {
  orgId: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  /** Raw x-brand-id header value (CSV string) — used for forwarding to downstream services */
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  customerPersonaId?: string;
  customerProfileId?: string;
}

function optionalString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function extractOrgContext(req: Request): OrgContext | null {
  const orgId = optionalString(req.headers["x-org-id"]);
  if (!orgId) return null;

  const brandId = optionalString(req.headers["x-brand-id"]);

  return {
    orgId,
    userId: optionalString(req.headers["x-user-id"]),
    runId: optionalString(req.headers["x-run-id"]),
    campaignId: optionalString(req.headers["x-campaign-id"]),
    brandId,
    workflowSlug: optionalString(req.headers["x-workflow-slug"]),
    featureSlug: optionalString(req.headers["x-feature-slug"]),
    customerPersonaId: optionalString(req.headers["x-customer-persona-id"]),
    customerProfileId: optionalString(req.headers["x-customer-profile-id"]),
  };
}

export function requireOrgId(req: Request, res: Response, next: NextFunction) {
  const ctx = extractOrgContext(req);
  if (!ctx) {
    res.status(400).json({ error: "Missing required header: x-org-id" });
    return;
  }

  res.locals.orgContext = ctx;
  next();
}
