import { config } from "../config";
import { buildServiceHeaders } from "./service-headers";
import type { OrgContext } from "../middleware/requireOrgId";

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 500;

export interface PassthroughResponse {
  status: number;
  bodyText: string;
  contentType: string | null;
}

export async function instantlyPassthrough(
  path: string,
  options: { method?: string; body?: unknown; ctx?: OrgContext } = {},
): Promise<PassthroughResponse> {
  const { method = "GET", body, ctx } = options;
  const fullUrl = `${config.instantly.url}${path}`;
  const headers = buildServiceHeaders(config.instantly.apiKey, ctx);
  const jsonBody = body !== undefined ? JSON.stringify(body) : undefined;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(fullUrl, {
        method,
        headers,
        body: jsonBody,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const bodyText = await response.text();
      return {
        status: response.status,
        bodyText,
        contentType: response.headers.get("content-type"),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(
    `instantly-service ${method} ${path}: ${lastError?.message ?? "fetch failed"} (url: ${config.instantly.url})`,
  );
}
