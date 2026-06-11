import http from "node:http";
import type { ScheduledTask } from "node-cron";
import { config } from "./config";
import { logger } from "./config/logger";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { createApp } from "./app";
import { startMonitoring } from "./services/monitoring";
import { startLifecycle } from "./services/monitoring/lifecycle";

async function bootstrap(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);

  server.on("listening", () => {
    logger.info(`🚀 Schbang Pulse backend on :${config.port} (${config.env}) — mail: ${config.mail.driver}`);
  });

  // On a hot-reload, tsx watch may start this process before the previous one
  // has finished releasing the port. Instead of crashing, patiently retry the
  // bind — the old instance shuts down fast (below) and frees it within ~1s.
  const MAX_BIND_RETRIES = 20; // ~10s at 500ms — covers any reload race
  let bindAttempts = 0;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      bindAttempts += 1;
      if (bindAttempts > MAX_BIND_RETRIES) {
        logger.error(
          `Port ${config.port} still in use after ${MAX_BIND_RETRIES} attempts (~10s). ` +
            `Another backend is likely running — stop it with: npm run kill-port`,
        );
        process.exit(1);
      }
      if (bindAttempts === 1) {
        logger.warn(`Port ${config.port} busy — previous instance is still releasing it; retrying…`);
      }
      setTimeout(() => server.listen(config.port), 500).unref();
      return;
    }
    throw err;
  });

  server.listen(config.port);

  // In-process crons (no AWS): monitoring checks (every ~20s) + lifecycle (hourly).
  const monitoringTask: ScheduledTask = startMonitoring();
  const lifecycleTask: ScheduledTask = startLifecycle();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // ignore repeated signals during a restart
    shuttingDown = true;
    logger.info(`${signal} received — shutting down`);
    monitoringTask.stop();
    lifecycleTask.stop();
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
