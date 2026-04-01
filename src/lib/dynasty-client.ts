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

interface IdentityHeaders {
  orgId: string;
  userId: string;
  runId: string;
}

async function fetchJson<T>(url: string, apiKey: string, identityHeaders?: IdentityHeaders): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      ...(identityHeaders && {
        "x-org-id": identityHeaders.orgId,
        "x-user-id": identityHeaders.userId,
        "x-run-id": identityHeaders.runId,
      }),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`dynasty-client GET ${url}: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

export async function resolveWorkflowDynastySlugs(dynastySlug: string, identityHeaders?: IdentityHeaders): Promise<string[]> {
  const { url, apiKey } = config.workflow;
  const endpoint = `${url}/workflows/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  const result = await fetchJson<DynastySlugResponse>(endpoint, apiKey, identityHeaders);
  return result.slugs;
}

export async function resolveFeatureDynastySlugs(dynastySlug: string, identityHeaders?: IdentityHeaders): Promise<string[]> {
  const { url, apiKey } = config.features;
  const endpoint = `${url}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  const result = await fetchJson<DynastySlugResponse>(endpoint, apiKey, identityHeaders);
  return result.slugs;
}

export async function fetchWorkflowDynasties(identityHeaders?: IdentityHeaders): Promise<Dynasty[]> {
  const { url, apiKey } = config.workflow;
  const endpoint = `${url}/workflows/dynasties`;
  const result = await fetchJson<DynastiesResponse>(endpoint, apiKey, identityHeaders);
  return result.dynasties;
}

export async function fetchFeatureDynasties(identityHeaders?: IdentityHeaders): Promise<Dynasty[]> {
  const { url, apiKey } = config.features;
  const endpoint = `${url}/features/dynasties`;
  const result = await fetchJson<DynastiesResponse>(endpoint, apiKey, identityHeaders);
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
