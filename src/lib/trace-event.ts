import { config } from "../config";
import type { OrgContext } from "../middleware/requireOrgId";

export function traceEvent(
  ctx: OrgContext | undefined,
  event: string,
  detail: string,
): void {
  if (!ctx?.runId) return;
  if (!config.runs.url || !config.runs.apiKey) return;

  const url = `${config.runs.url}/v1/runs/${ctx.runId}/events`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": config.runs.apiKey,
  };

  if (ctx.orgId) headers["x-org-id"] = ctx.orgId;
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;
  if (ctx.campaignId) headers["x-campaign-id"] = ctx.campaignId;
  if (ctx.workflowSlug) headers["x-workflow-slug"] = ctx.workflowSlug;
  if (ctx.featureSlug) headers["x-feature-slug"] = ctx.featureSlug;

  fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ event, detail }),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[email-gateway] traceEvent failed: ${message}`);
  });
}
