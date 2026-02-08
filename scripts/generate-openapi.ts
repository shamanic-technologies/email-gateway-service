import {
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas";
import * as fs from "fs";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Email Sending Service",
    version: "1.0.0",
    description:
      "Unified gateway for transactional and broadcast email sending",
  },
  servers: [{ url: "http://localhost:3009" }],
});

fs.writeFileSync("openapi.json", JSON.stringify(document, null, 2));
console.log("Generated openapi.json");
