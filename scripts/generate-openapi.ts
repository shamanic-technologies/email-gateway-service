import {
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas";
import * as fs from "fs";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Email Gateway",
    version: "1.0.0",
    description:
      "Email gateway that routes emails to Postmark (transactional) or Instantly (broadcast) based on type.",
  },
  servers: [{ url: "http://localhost:3009", description: "Local development" }],
  tags: [
    { name: "Health", description: "Health check endpoints" },
    { name: "Email Routing", description: "Route emails to transactional or broadcast providers" },
    { name: "Stats", description: "Email delivery statistics" },
    { name: "Status", description: "Email delivery status batch lookup" },
    { name: "Inbound", description: "Inbound email fan-out to subscribers" },
    { name: "Manual Qualifications", description: "Manual reply classification proxy to instantly-service" },
    { name: "Webhooks", description: "Provider webhook forwarding" },
  ],
});

fs.writeFileSync("openapi.json", JSON.stringify(document, null, 2));
console.log("Generated openapi.json");
