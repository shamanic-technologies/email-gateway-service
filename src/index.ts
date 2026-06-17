import express from "express";
import cors from "cors";
import { config } from "./config";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { requireOrgId } from "./middleware/requireOrgId";
import healthRoutes from "./routes/health";
import sendRoutes from "./routes/send";
import statusRoutes from "./routes/status";
import statsRoutes, { publicStatsRouter } from "./routes/stats";
import webhooksRoutes from "./routes/webhooks";
import inboundRoutes from "./routes/inbound";
import manualQualificationsRoutes from "./routes/manual-qualifications";
import { registerProviderRequirements } from "./lib/register-providers";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Public routes (no auth)
app.use(healthRoutes);
app.use("/webhooks", webhooksRoutes);

// Internal routes (apiKeyAuth) — service-to-service inbound from postmark-service etc.
app.use("/inbound", apiKeyAuth, inboundRoutes);

// Public routes with apiKeyAuth only (no identity headers required)
app.use("/public", apiKeyAuth, publicStatsRouter);

// Org-scoped routes (apiKeyAuth + requireOrgId)
app.use("/orgs", apiKeyAuth, requireOrgId, sendRoutes);
app.use("/orgs", apiKeyAuth, requireOrgId, statusRoutes);
app.use("/orgs", apiKeyAuth, requireOrgId, statsRoutes);
app.use("/orgs", apiKeyAuth, requireOrgId, manualQualificationsRoutes);

if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  app.listen(config.port, () => {
    console.log(`[email-gateway] running on port ${config.port}`);
    registerProviderRequirements().catch((err) => {
      console.error("[email-gateway] Provider registration failed:", err.message);
      process.exit(1);
    });
  });
}

export { app };
