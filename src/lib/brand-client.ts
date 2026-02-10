import { config } from "../config";

interface BrandDetail {
  id: string;
  brandUrl: string | null;
  name: string | null;
  domain: string | null;
}

export async function getBrand(brandId: string): Promise<BrandDetail> {
  const res = await fetch(`${config.brand.url}/brands/${brandId}`, {
    headers: { "X-API-Key": config.brand.apiKey },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`brand-service GET /brands/${brandId}: ${res.status} - ${text}`);
  }

  const data = (await res.json()) as { brand: BrandDetail };
  return data.brand;
}
