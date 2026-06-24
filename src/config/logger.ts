import { pino } from "pino";
import { config } from "./index";

/**
 * Clean, human-readable single-line logs in every environment (dev + prod).
 * The per-request HTTP log is reduced to one line in app.ts; here we just drop
 * the noisy structural fields so the console reads like an app log, not a dump.
 */
export const logger = pino({
  level: config.isProd ? "info" : "debug",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:HH:MM:ss",
      singleLine: true,
      ignore: "pid,hostname,req,res,responseTime,reqId,context",
    },
  },
});
