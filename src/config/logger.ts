import { pino } from "pino";
import { config } from "./index";

/**
 * Clean, human-readable single-line logs in every environment (dev + prod).
 * The per-request HTTP log is reduced to one line in app.ts; here we just drop
 * the noisy structural fields so the console reads like an app log, not a dump.
 */
export const logger = pino({
  level: config.isProd ? "info" : "debug",
  // pino-pretty is a dev-only tool (extra worker thread + non-JSON output). In
  // production emit structured JSON so log aggregators can parse it and the
  // hot path isn't paying the pretty-printer's cost.
  transport: config.isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          singleLine: true,
          ignore: "pid,hostname,req,res,responseTime,reqId,context",
        },
      },
});
