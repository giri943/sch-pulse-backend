import type { ScheduledTask } from "node-cron";
import { config } from "./config";
import { logger } from "./config/logger";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { createApp } from "./app";
import { startMonitoring } from "./services/monitoring";

async function bootstrap(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`🚀 Schbang Pulse backend on :${config.port} (${config.env}) — mail: ${config.mail.driver}`);
  });

  // Friendly message instead of an ugly crash if the port is already taken.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        `Port ${config.port} is already in use — another backend instance is still running. ` +
          `Stop it first (npm run kill-port), or it will free up momentarily on restart.`,
      );
      process.exit(1);
    }
    throw err;
  });

  // In-process monitoring cron (no AWS). This is the single-process design.
  const monitoringTask: ScheduledTask = startMonitoring();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // ignore repeated signals during a restart
    shuttingDown = true;
    logger.info(`${signal} received — shutting down`);
    monitoringTask.stop();
    // Immediately drop keep-alive sockets (e.g. the dashboard's polling) so the
    // port is released right away — otherwise tsx watch's new process hits EADDRINUSE.
    server.closeAllConnections?.();
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
    // Hard stop fast so a hot-reload can rebind without waiting.
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error({ reason }, "Unhandled rejection"));
}

bootstrap().catch((err) => {
  logger.error({ err }, "Failed to start backend");
  process.exit(1);
});
