import * as dotenv from "dotenv";
dotenv.config();

const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
if (!apiKey) {
  console.error("[email-gateway] FATAL: EMAIL_GATEWAY_SERVICE_API_KEY env var is missing");
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 3009,
  apiKey,

  postmark: {
    url: process.env.POSTMARK_SERVICE_URL || "http://localhost:3010",
    apiKey: process.env.POSTMARK_SERVICE_API_KEY || "",
  },
  instantly: {
    url: process.env.INSTANTLY_SERVICE_URL || "http://localhost:3011",
    apiKey: process.env.INSTANTLY_SERVICE_API_KEY || "",
  },
  brand: {
    url: process.env.BRAND_SERVICE_URL || "http://localhost:3005",
    apiKey: process.env.BRAND_SERVICE_API_KEY || "",
  },
  key: {
    url: process.env.KEY_SERVICE_URL || "",
    apiKey: process.env.KEY_SERVICE_API_KEY || "",
  },
  features: {
    url: process.env.FEATURES_SERVICE_URL || "",
    apiKey: process.env.FEATURES_SERVICE_API_KEY || "",
  },
  workflow: {
    url: process.env.WORKFLOW_SERVICE_URL || "",
    apiKey: process.env.WORKFLOW_SERVICE_API_KEY || "",
  },
} as const;
