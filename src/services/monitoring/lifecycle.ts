import cron, { type ScheduledTask } from "node-cron";
import { Monitor } from "../../models/monitor.model";
import { Check } from "../../models/check.model";
import { Incident } from "../../models/incident.model";
import { UptimeStat } from "../../models/uptimeStat.model";
import { User } from "../../models/user.model";
import { logger } from "../../config/logger";
import { sendEmail, monitorExpiringEmail, monitorExpiredEmail } from "../mailer";
import { notifyChannels } from "../channels";

const DAY = 24 * 60 * 60 * 1000;
const REMINDER_DAYS = [3, 2, 1]; // daily reminders in the final 3 days
const PURGE_AFTER_DAYS = 7; // hard-delete this long after soft-delete

interface LifecycleMonitor {
  _id: unknown;
  name: string;
  url: string;
  members?: unknown[];
  extraAlertEmails?: string[];
  channels?: unknown[];
  expiresAt?: Date | null;
  expiryRemindersSent?: number[];
}

async function recipients(m: LifecycleMonitor): Promise<string[]> {
  let emails: string[] = [];
  if (m.members?.length) {
    const users = await User.find({ _id: { $in: m.members } }).select("email").lean();
    emails = users.map((u) => u.email);
  }
  return [...new Set([...emails, ...(m.extraAlertEmails ?? [])])];
}

/** One lifecycle pass: expiry reminders, soft-delete on expiry, purge old soft-deletes. */
export async function runLifecycle(): Promise<void> {
  const now = new Date();

  // 1) Reminders + soft-delete for monitors with a monitoring period.
  const active = (await Monitor.find({ softDeletedAt: null, expiresAt: { $ne: null } }).lean()) as unknown as LifecycleMonitor[];
  for (const m of active) {
    const exp = new Date(m.expiresAt as Date);
    const daysRemaining = Math.ceil((exp.getTime() - now.getTime()) / DAY);

    if (exp.getTime() <= now.getTime()) {
      await Monitor.updateOne({ _id: m._id }, { softDeletedAt: now, enabled: false, status: "paused" });
      const to = await recipients(m);
      await sendEmail(monitorExpiredEmail({ to, monitorName: m.name, url: m.url }));
      await notifyChannels(
        m.channels,
        `🗑️ Monitoring ended for *${m.name}* (${m.url}). It will be permanently deleted in ${PURGE_AFTER_DAYS} days unless restored.`,
      );
      logger.info({ monitorId: String(m._id) }, "Monitor soft-deleted (period ended)");
    } else if (REMINDER_DAYS.includes(daysRemaining) && !(m.expiryRemindersSent ?? []).includes(daysRemaining)) {
      await Monitor.updateOne({ _id: m._id }, { $addToSet: { expiryRemindersSent: daysRemaining } });
      const to = await recipients(m);
      await sendEmail(monitorExpiringEmail({ to, monitorName: m.name, url: m.url, daysRemaining, expiresAt: exp.toISOString() }));
      await notifyChannels(
        m.channels,
        `⏳ Monitoring for *${m.name}* (${m.url}) ends in ${daysRemaining} day(s) on ${exp.toDateString()}. Extend it to keep monitoring.`,
      );
      logger.info({ monitorId: String(m._id), daysRemaining }, "Expiry reminder sent");
    }
  }

  // 2) Permanently delete monitors soft-deleted more than PURGE_AFTER_DAYS ago (cascade).
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY);
  const toPurge = await Monitor.find({ softDeletedAt: { $ne: null, $lte: cutoff } }).select("_id").lean();
  for (const m of toPurge) {
    await Promise.all([
      Check.deleteMany({ monitorId: m._id }),
      Incident.deleteMany({ monitorId: m._id }),
      UptimeStat.deleteMany({ monitorId: m._id }),
    ]);
    await Monitor.deleteOne({ _id: m._id });
    logger.warn({ monitorId: String(m._id) }, "Monitor permanently deleted (purge)");
  }
}

/** Hourly lifecycle cron. Reminders dedupe per day so hourly runs are safe. */
export function startLifecycle(): ScheduledTask {
  logger.info("Lifecycle cron started (hourly)");
  const task = cron.schedule("0 * * * *", () => {
    runLifecycle().catch((err) => logger.error({ err }, "Lifecycle pass failed"));
  });
  runLifecycle().catch((err) => logger.error({ err }, "Initial lifecycle pass failed"));
  return task;
}
