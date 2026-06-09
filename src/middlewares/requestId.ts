import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Attach a correlation id to every request for log tracing. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.id = req.header("x-request-id") || randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
}
