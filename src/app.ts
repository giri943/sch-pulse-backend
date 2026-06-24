import express, { type Application, type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { config } from "./config";
import { logger } from "./config/logger";
import { pingDatabase } from "./config/database";
import { requestId } from "./middlewares/requestId";
import { globalRateLimiter } from "./middlewares/rateLimit";
import { errorConverter, errorHandler, notFound } from "./middlewares/error";
import apiRouter from "./routes";
import "./utils/types"; // augment Express.Request

export function createApp(): Application {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(requestId);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).id,
      // Keep each request to ONE clean line. Dropping the default req/res
      // serializers also stops logging headers — incl. the Authorization JWT.
      serializers: { req: () => undefined, res: () => undefined },
      customSuccessMessage: (req, res, responseTime) => `${req.method} ${req.url} ${res.statusCode} · ${responseTime}ms`,
      customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode} - ${err.message}`,
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        if (req.url === "/healthz" || req.url === "/readyz") return "silent";
        return "info";
      },
    }),
  );
  app.use(globalRateLimiter);

  app.get("/healthz", (_req: Request, res: Response) => res.json({ status: "ok" }));
  app.get("/readyz", async (_req: Request, res: Response) => {
    const dbOk = await pingDatabase();
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? "ready" : "degraded", db: dbOk });
  });

  app.use("/api/v1", apiRouter);

  app.use(notFound);
  app.use(errorConverter);
  app.use(errorHandler);

  return app;
}
