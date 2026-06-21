import type { OrgContext } from "../middleware/requireOrgId";

export function buildServiceHeaders(apiKey: string, ctx?: OrgContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };

  if (!ctx) return headers;

  if (ctx.orgId) headers["x-org-id"] = ctx.orgId;
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.campaignId) headers["x-campaign-id"] = ctx.campaignId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;
  if (ctx.workflowSlug) headers["x-workflow-slug"] = ctx.workflowSlug;
  if (ctx.featureSlug) headers["x-feature-slug"] = ctx.featureSlug;
  if (ctx.audienceId) headers["x-audience-id"] = ctx.audienceId;

  return headers;
}
