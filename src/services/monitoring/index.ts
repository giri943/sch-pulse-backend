import cron, { type ScheduledTask } from "node-cron";
import { Monitor } from "../../models/monitor.model";
import { config } from "../../config";
import { logger } from "../../config/logger";
import { websiteCheck } from "./checks/website";
import { apiCheck } from "./checks/api";
import { sslCheck } from "./checks/ssl";
import type { CheckFn, MonitorWithId } from "./types";
import { processResult } from "./incident";
import { probeSslExpiry } from "./sslProbe";

const CHECKS: Record<string, CheckFn> = {
  website: websiteCheck,
  api: apiCheck,
  ssl: sslCheck,
};

let ticking = false;

/** Run the right check for a monitor and persist the outcome. */
export async function runCheck(monitor: MonitorWithId): Promise<void> {
  const check = CHECKS[monitor.type];
  if (!check) {
    logger.error({ type: monitor.type }, "No check handler for monitor type");
    return;
  }
  const result = await check(monitor);
  // Auto-track SSL on any https monitor (website/api), not just dedicated SSL monitors.
  if (!result.sslExpiresAt && monitor.url.startsWith("https://")) {
    const expiry = await probeSslExpiry(monitor.url, monitor.timeoutMs ?? 8000);
    if (expiry) result.sslExpiresAt = expiry;
  }
  await processResult(monitor, result);
  logger.debug({ monitorId: String(monitor._id), up: result.up, ms: result.responseTimeMs }, "Check processed");
}

/** Run tasks with a bounded concurrency pool. */
async function runPool<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        await task(item);
      } catch (err) {
        logger.error({ err }, "Check task failed");
      }
    }
  });
  await Promise.all(workers);
}

/**
 * One scheduler tick: claim enabled monitors that are due (nextRunAt <= now),
 * advance their nextRunAt by their interval, then run their checks with bounded
 * concurrency. This is the in-process replacement for EventBridge + SQS.
 */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    // Only "full" monitors get uptime health checks. SSL-only / Domain-only
    // scopes are handled by the hourly lifecycle cron (expiry alerts only).
    // ($nin also matches legacy monitors with no monitoringScope field = full.)
    const due = (await Monitor.find({
      enabled: true,
      nextRunAt: { $lte: now },
      monitoringScope: { $nin: ["ssl", "domain"] },
    })
      .limit(500)
      .lean()) as MonitorWithId[];
    if (!due.length) return;

    // Advance every due monitor's nextRunAt in a single round-trip (was one
    // updateOne per monitor — N round-trips per tick).
    await Monitor.bulkWrite(
      due.map((m) => ({
        updateOne: {
          filter: { _id: m._id },
          update: { nextRunAt: new Date(now.getTime() + (m.intervalSec ?? 300) * 1000) },
        },
      })),
    );
    await runPool(due, config.scheduler.concurrency, runCheck);
    logger.info({ count: due.length }, `Health checks: ${due.length} monitors checked this cycle`);
  } finally {
    ticking = false;
  }
}

/** Start the in-process monitoring cron. Returns the task so it can be stopped. */
export function startMonitoring(): ScheduledTask {
  logger.info({ cron: config.scheduler.cron }, "Health-check scheduler started - probing due monitors every 20s");
  const task = cron.schedule(config.scheduler.cron, () => {
    tick().catch((err) => logger.error({ err }, "Health-check cycle failed"));
  });
  tick().catch((err) => logger.error({ err }, "Health-check cycle failed"));
  return task;
}
