import * as dotenv from "dotenv";
dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 3009,
  apiKey: process.env.EMAIL_SENDING_SERVICE_API_KEY || "",
  databaseUrl: process.env.EMAIL_SENDING_SERVICE_DATABASE_URL || "",
  emailFromAddress: process.env.EMAIL_FROM_ADDRESS || "growth@mcpfactory.org",
  postmark: {
    url: process.env.POSTMARK_SERVICE_URL || "http://localhost:3010",
    apiKey: process.env.POSTMARK_SERVICE_API_KEY || "",
  },
  instantly: {
    url: process.env.INSTANTLY_SERVICE_URL || "http://localhost:3011",
    apiKey: process.env.INSTANTLY_SERVICE_API_KEY || "",
  },
} as const;
