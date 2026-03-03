import { Request, Response, NextFunction } from "express";

export function requireIdentityHeaders(req: Request, res: Response, next: NextFunction) {
  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];
  const runId = req.headers["x-run-id"];

  if (!orgId || typeof orgId !== "string") {
    res.status(400).json({ error: "Missing required header: x-org-id" });
    return;
  }

  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: "Missing required header: x-user-id" });
    return;
  }

  if (!runId || typeof runId !== "string") {
    res.status(400).json({ error: "Missing required header: x-run-id" });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;
  res.locals.runId = runId;
  next();
}
