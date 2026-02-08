import express from "express";
import cors from "cors";
import { config } from "./config";
import { serviceAuth } from "./middleware/serviceAuth";
import healthRoutes from "./routes/health";
import sendRoutes from "./routes/send";
import statsRoutes from "./routes/stats";
import webhooksRoutes from "./routes/webhooks";

const app = express();

app.use(cors());
app.use(express.json());

// Public routes (no auth)
app.use(healthRoutes);
app.use("/webhooks", webhooksRoutes);

// Protected routes (require X-API-Key)
app.use(serviceAuth, sendRoutes);
app.use(serviceAuth, statsRoutes);

app.listen(config.port, () => {
  console.log(`email-sending-service running on port ${config.port}`);
});

export { app };
