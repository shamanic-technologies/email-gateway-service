import { config } from "../config";

interface BrandDetail {
  id: string;
  brandUrl: string | null;
  name: string | null;
  domain: string | null;
}

interface IdentityHeaders {
  orgId: string;
  userId: string;
  runId: string;
}

interface TrackingHeaders {
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
}

export async function getBrand(brandId: string, identityHeaders?: IdentityHeaders, trackingHeaders?: TrackingHeaders): Promise<BrandDetail> {
  const res = await fetch(`${config.brand.url}/brands/${brandId}`, {
    headers: {
      "X-API-Key": config.brand.apiKey,
      ...(identityHeaders && {
        "x-org-id": identityHeaders.orgId,
        "x-user-id": identityHeaders.userId,
        "x-run-id": identityHeaders.runId,
      }),
      ...(trackingHeaders?.campaignId && { "x-campaign-id": trackingHeaders.campaignId }),
      ...(trackingHeaders?.brandId && { "x-brand-id": trackingHeaders.brandId }),
      ...(trackingHeaders?.workflowName && { "x-workflow-name": trackingHeaders.workflowName }),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`brand-service GET /brands/${brandId}: ${res.status} - ${text}`);
  }

  const data = (await res.json()) as { brand: BrandDetail };
  return data.brand;
}
