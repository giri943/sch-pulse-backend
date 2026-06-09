import { pino } from "pino";
import { config } from "./index";

export const logger = pino({
  level: config.isProd ? "info" : "debug",
  ...(config.isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname,req,res,responseTime,reqId",
          },
        },
      }),
});
