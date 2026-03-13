import { config } from "../config";

interface ProviderRequirement {
  service: string;
  method: string;
  path: string;
  provider: string;
}

interface ProviderRequirementsResponse {
  requirements: ProviderRequirement[];
  providers: string[];
}

// Downstream endpoints that email-gateway proxies to
const DOWNSTREAM_ENDPOINTS = [
  { service: "instantly", method: "POST", path: "/send" },
  { service: "postmark", method: "POST", path: "/send" },
];

// email-gateway endpoints that route to downstream providers
const GATEWAY_ENDPOINTS = [
  { method: "POST", path: "/send" },
];

/**
 * On startup, query key-service for the providers required by our downstream
 * services, then register those same providers under the email-gateway service
 * name by calling the platform-key decrypt endpoint with X-Caller-* headers.
 *
 * This seeds the provider_requirements table so that workflow-service can
 * discover that email-gateway POST /send needs "instantly" and "postmark".
 */
export async function registerProviderRequirements(): Promise<void> {
  if (!config.key.url || !config.key.apiKey) {
    console.warn(
      "KEY_SERVICE_URL or KEY_SERVICE_API_KEY not set — skipping provider registration"
    );
    return;
  }

  // Step 1: Query key-service for downstream provider requirements
  const res = await fetch(`${config.key.url}/provider-requirements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.key.apiKey,
    },
    body: JSON.stringify({ endpoints: DOWNSTREAM_ENDPOINTS }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(
      `Failed to query provider requirements: ${res.status} ${text}`
    );
    return;
  }

  const data = (await res.json()) as ProviderRequirementsResponse;
  const providers = [...new Set(data.requirements.map((r) => r.provider))];

  if (providers.length === 0) {
    console.warn("No downstream provider requirements found — nothing to register");
    return;
  }

  // Step 2: Register each provider under the email-gateway service name
  // by calling the platform-key decrypt endpoint with X-Caller-* headers.
  // The decrypt call may 404 (no platform key stored) — that's fine,
  // key-service still records the caller→provider mapping.
  const results = await Promise.allSettled(
    GATEWAY_ENDPOINTS.flatMap((endpoint) =>
      providers.map(async (provider) => {
        const decryptRes = await fetch(
          `${config.key.url}/keys/platform/${provider}/decrypt`,
          {
            method: "GET",
            headers: {
              "x-api-key": config.key.apiKey,
              "x-caller-service": "email-gateway",
              "x-caller-method": endpoint.method,
              "x-caller-path": endpoint.path,
            },
            signal: AbortSignal.timeout(5000),
          }
        );
        // 404 is expected (no platform key) — the mapping is still recorded
        if (!decryptRes.ok && decryptRes.status !== 404) {
          const text = await decryptRes.text();
          console.warn(
            `Provider registration warning for ${provider}: ${decryptRes.status} ${text}`
          );
        }
        return { provider, endpoint, status: decryptRes.status };
      })
    )
  );

  const registered = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<{ provider: string }>).value.provider);

  console.log(
    `Registered provider requirements: email-gateway → [${registered.join(", ")}]`
  );
}
