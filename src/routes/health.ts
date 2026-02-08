import { Router } from "express";
import * as fs from "fs";
import * as path from "path";

const router = Router();

router.get("/", (_req, res) => {
  res.json({ service: "email-sending-service", version: "1.0.0" });
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "email-sending-service", version: "1.0.0" });
});

router.get("/openapi.json", (_req, res) => {
  const openapiPath = path.resolve(__dirname, "../../openapi.json");
  if (fs.existsSync(openapiPath)) {
    const spec = JSON.parse(fs.readFileSync(openapiPath, "utf-8"));
    res.json(spec);
  } else {
    res.status(404).json({ error: "OpenAPI spec not found" });
  }
});

export default router;
