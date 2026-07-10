import dns from "node:dns";
// Prefer IPv4 for all outbound connections. Some cloud egress paths (e.g. Render)
// have a broken IPv6 route to certain hosts, which surfaces as
// "fetch failed: read ECONNRESET" when calling HTTPS APIs like Mailjet. Resolving
// IPv4-first avoids that bad path. Must run before any fetch/DNS lookup.
dns.setDefaultResultOrder("ipv4first");

import http from "node:http";
import type { ScheduledTask } from "node-cron";
import { config } from "./config";
import { logger } from "./config/logger";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { createApp } from "./app";
import { startMonitoring } from "./services/monitoring";
import { startLifecycle } from "./services/monitoring/lifecycle";
import { startIncidentLifecycle } from "./services/monitoring/incidentLifecycle";
import { freePort } from "./utils/freePort";
import { ensureSystemRoles, ensureSuperAdmins } from "./utils/systemRoles";
import { ensureDefaultProject } from "./utils/ensureDefaultProject";
import { syncAllIndexes } from "./utils/syncIndexes";

async function bootstrap(): Promise<void> {
  // In dev, a hot-reload can leave the previous process holding the port (and
  // running its crons). Reclaim it before binding — nodemon-style force restart.
  if (!config.isProd) await freePort(config.port);

  await connectDatabase();
  // Prod runs with autoIndex off, so build schema indexes (TTLs, unique keys,
  // query indexes) explicitly on boot. Idempotent — a no-op when nothing changed.
  await syncAllIndexes();
  await ensureSystemRoles();
  await ensureSuperAdmins();
  await ensureDefaultProject();

  const app = createApp();
  const server = http.createServer(app);

  server.on("listening", () => {
    logger.info(
      `Schbang Pulse backend on :${config.port} (${config.env}) - mail: ${config.mail.driver} from <${config.mail.from}>`,
    );
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
        logger.warn(`Port ${config.port} busy - reclaiming it from the previous instance...`);
      }
      // Actively kill whatever still holds the port (a dying reload often lingers
      // a moment after leaving LISTENING), then retry the bind.
      const retry = () => setTimeout(() => server.listen(config.port), 250).unref();
      if (!config.isProd) void freePort(config.port).finally(retry);
      else retry();
      return;
    }
    throw err;
  });

  server.listen(config.port);

  // In-process crons (no AWS): monitoring checks (every ~20s) + lifecycle (hourly).
  // Disable on a secondary/local instance (SCHEDULER_ENABLED=false) so it doesn't
  // double-check the same sites as production.
  let monitoringTask: ScheduledTask | null = null;
  let lifecycleTask: ScheduledTask | null = null;
  let incidentLifecycleTask: ScheduledTask | null = null;
  if (config.scheduler.enabled) {
    monitoringTask = startMonitoring();
    lifecycleTask = startLifecycle();
    incidentLifecycleTask = startIncidentLifecycle();
  } else {
    logger.warn("Background jobs disabled (SCHEDULER_ENABLED=false) - API-only: no health checks, renewals, or escalations");
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // ignore repeated signals during a restart
    shuttingDown = true;
    logger.info(`${signal} received - shutting down`);
    monitoringTask?.stop();
    lifecycleTask?.stop();
    incidentLifecycleTask?.stop();
    // Immediately drop keep-alive sockets (e.g. the dashboard's polling) so the
    // port is released right away — otherwise tsx watch's new process hits EADDRINUSE.
    server.closeAllConnections?.();
    server.close();
    void disconnectDatabase().finally(() => process.exit(0));
    // Hard stop very fast so the OS releases the port for the reloading process.
    setTimeout(() => process.exit(0), 300).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error({ reason }, "Unhandled rejection"));
  // After an uncaught exception the process is in an undefined state — log and
  // exit so the supervisor (pm2) restarts a clean one rather than serving from
  // a corrupted process. /readyz makes the restart safe.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception - shutting down");
    shutdown("uncaughtException");
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, "Failed to start backend");
  process.exit(1);
});
