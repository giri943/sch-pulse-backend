import rateLimit from "express-rate-limit";
import { config } from "../config";

/** Global limiter applied to the whole API. */
export const globalRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "TOO_MANY_REQUESTS", message: "Rate limit exceeded" } },
});

/** Stricter limiter for sensitive auth endpoints (login/forgot). */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "TOO_MANY_REQUESTS", message: "Too many attempts, try later" } },
});
