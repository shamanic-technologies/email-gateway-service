import { config } from "../config";

const TIMEOUT_MS = 10_000;

interface DynastySlugResponse {
  slugs: string[];
}

interface Dynasty {
  dynastySlug: string;
  slugs: string[];
}

interface DynastiesResponse {
  dynasties: Dynasty[];
}

async function fetchJson<T>(url: string, apiKey: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`dynasty-client GET ${url}: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

export async function resolveWorkflowDynastySlugs(dynastySlug: string): Promise<string[]> {
  const { url, apiKey } = config.workflow;
  const endpoint = `${url}/workflows/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  console.log(`[email-gateway] Resolving workflow dynasty slug: ${dynastySlug}`);
  const result = await fetchJson<DynastySlugResponse>(endpoint, apiKey);
  return result.slugs;
}

export async function resolveFeatureDynastySlugs(dynastySlug: string): Promise<string[]> {
  const { url, apiKey } = config.features;
  const endpoint = `${url}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  console.log(`[email-gateway] Resolving feature dynasty slug: ${dynastySlug}`);
  const result = await fetchJson<DynastySlugResponse>(endpoint, apiKey);
  return result.slugs;
}

export async function fetchWorkflowDynasties(): Promise<Dynasty[]> {
  const { url, apiKey } = config.workflow;
  const endpoint = `${url}/workflows/dynasties`;
  console.log(`[email-gateway] Fetching all workflow dynasties`);
  const result = await fetchJson<DynastiesResponse>(endpoint, apiKey);
  return result.dynasties;
}

export async function fetchFeatureDynasties(): Promise<Dynasty[]> {
  const { url, apiKey } = config.features;
  const endpoint = `${url}/features/dynasties`;
  console.log(`[email-gateway] Fetching all feature dynasties`);
  const result = await fetchJson<DynastiesResponse>(endpoint, apiKey);
  return result.dynasties;
}

export function buildSlugToDynastyMap(dynasties: Dynasty[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.slugs) {
      map.set(slug, d.dynastySlug);
    }
  }
  return map;
}
