import { config } from "../config";

interface IdentityHeaders {
  orgId: string;
  userId: string;
  runId: string;
}

interface TrackingHeaders {
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

interface ExtractedField {
  key: string;
  value: string;
}

export async function extractFields(
  fields: Array<{ key: string; description: string }>,
  identityHeaders?: IdentityHeaders,
  trackingHeaders?: TrackingHeaders,
): Promise<ExtractedField[]> {
  const res = await fetch(`${config.brand.url}/brands/extract-fields`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.brand.apiKey,
      ...(identityHeaders && {
        "x-org-id": identityHeaders.orgId,
        "x-user-id": identityHeaders.userId,
        "x-run-id": identityHeaders.runId,
      }),
      ...(trackingHeaders?.campaignId && { "x-campaign-id": trackingHeaders.campaignId }),
      ...(trackingHeaders?.brandId && { "x-brand-id": trackingHeaders.brandId }),
      ...(trackingHeaders?.workflowSlug && { "x-workflow-slug": trackingHeaders.workflowSlug }),
      ...(trackingHeaders?.featureSlug && { "x-feature-slug": trackingHeaders.featureSlug }),
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`brand-service POST /brands/extract-fields: ${res.status} - ${text}`);
  }

  const data = (await res.json()) as { fields: ExtractedField[] };
  return data.fields;
}
