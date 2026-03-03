import express from "express";
import cors from "cors";
import { config } from "./config";
import { serviceAuth } from "./middleware/serviceAuth";
import { requireIdentityHeaders } from "./middleware/identityHeaders";
import healthRoutes from "./routes/health";
import sendRoutes from "./routes/send";
import statusRoutes from "./routes/status";
import statsRoutes from "./routes/stats";
import webhooksRoutes from "./routes/webhooks";

const app = express();

app.use(cors());
app.use(express.json());

// Public routes (no auth)
app.use(healthRoutes);
app.use("/webhooks", webhooksRoutes);

// Protected routes (require X-API-Key + identity headers)
app.use(serviceAuth, requireIdentityHeaders, sendRoutes);
app.use(serviceAuth, requireIdentityHeaders, statusRoutes);
app.use(serviceAuth, requireIdentityHeaders, statsRoutes);

app.listen(config.port, () => {
  console.log(`email-gateway running on port ${config.port}`);
});

export { app };
