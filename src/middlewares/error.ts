import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger";

/** 404 fallthrough for unmatched routes. */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.path}`));
}

/** Normalize any thrown value into an ApiError. */
export function errorConverter(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  if (err instanceof ApiError) return next(err);
  // Mongo duplicate key → 409
  if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) {
    return next(ApiError.conflict("Duplicate key", (err as { keyValue?: unknown }).keyValue));
  }
  const message = err instanceof Error ? err.message : "Something went wrong";
  next(new ApiError(500, message, "INTERNAL_ERROR"));
}

/** Final handler — the single place errors become HTTP responses. */
export function errorHandler(err: ApiError, req: Request, res: Response, _next: NextFunction): void {
  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) logger.error({ err, reqId: req.id }, err.message);
  else logger.warn({ code: err.code, reqId: req.id }, err.message);

  res.status(statusCode).json({
    error: {
      code: err.code || "INTERNAL_ERROR",
      message: statusCode >= 500 && err.code === "INTERNAL_ERROR" ? "Something went wrong" : err.message,
      details: err.details,
    },
  });
}
