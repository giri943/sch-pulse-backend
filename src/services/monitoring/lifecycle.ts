import cron, { type ScheduledTask } from "node-cron";
import { Monitor } from "../../models/monitor.model";
import { Check } from "../../models/check.model";
import { Incident } from "../../models/incident.model";
import { UptimeStat } from "../../models/uptimeStat.model";
import { User } from "../../models/user.model";
import { logger } from "../../config/logger";
import { sendEmail, monitorExpiringEmail, monitorExpiredEmail, domainExpiringEmail } from "../mailer";
import { notifyChannels, pulseChat, chatMonitorLink } from "../channels";
import { projectNameOf } from "../../utils/projectName";
import { monitorChatMentions } from "../../utils/mentions";

/** Short date like "12 Aug 2026". */
const shortDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
import { probeDomainExpiry } from "./domainProbe";
import { probeSslExpiry } from "./sslProbe";
import { handleSslWarnings } from "./incident";
import { purgeMaintenanceFor, purgeIncidentImagesFor, sweepOrphanProofs } from "../maintenanceCleanup";
import { createNotifications } from "../notify";
import type { MonitorWithId } from "./types";
import { DOMAIN_WARN_DAYS } from "../../utils/constants";

const DAY = 24 * 60 * 60 * 1000;
const REMINDER_DAYS = [3, 2, 1]; // daily reminders in the final 3 days
const PURGE_AFTER_DAYS = 7; // hard-delete this long after soft-delete
const DOMAIN_REFRESH_MS = 20 * 60 * 60 * 1000; // re-probe a domain's expiry at most ~daily

interface LifecycleMonitor {
  _id: unknown;
  name: string;
  url: string;
  projectId?: unknown;
  members?: unknown[];
  extraAlertEmails?: string[];
  channels?: unknown[];
  expiresAt?: Date | null;
  expiryRemindersSent?: number[];
  domainExpiresAt?: Date | null;
  domainCheckedAt?: Date | null;
  domainWarnedThresholds?: number[];
  monitoringScope?: "full" | "ssl" | "domain";
  timeoutMs?: number;
}

async function recipients(m: LifecycleMonitor): Promise<string[]> {
  let emails: string[] = [];
  if (m.members?.length) {
    const users = await User.find({ _id: { $in: m.members } }).select("email").lean();
    emails = users.map((u) => u.email);
  }
  return [...new Set([...emails, ...(m.extraAlertEmails ?? [])])];
}

// Re-entrancy guard: the hourly pass can run long (per-monitor RDAP probes), so
// skip a new pass if the previous one is still running rather than overlapping.
let lifecycleRunning = false;

/** One lifecycle pass: expiry reminders, soft-delete on expiry, purge old soft-deletes. */
export async function runLifecycle(): Promise<void> {
  if (lifecycleRunning) {
    logger.warn("Renewals & cleanup still running - skipping this run");
    return;
  }
  lifecycleRunning = true;
  try {
    await runLifecyclePass();
  } finally {
    lifecycleRunning = false;
  }
}

async function runLifecyclePass(): Promise<void> {
  const now = new Date();

  // 1) Reminders + soft-delete for monitors with a monitoring period.
  const active = (await Monitor.find({ softDeletedAt: null, expiresAt: { $ne: null } }).lean()) as unknown as LifecycleMonitor[];
  for (const m of active) {
    const exp = new Date(m.expiresAt as Date);
    const daysRemaining = Math.ceil((exp.getTime() - now.getTime()) / DAY);

    if (exp.getTime() <= now.getTime()) {
      await Monitor.updateOne({ _id: m._id }, { softDeletedAt: now, enabled: false, status: "paused" });
      const to = await recipients(m);
      const monitorId = String(m._id);
      await sendEmail(monitorExpiredEmail({ to, monitorName: m.name, url: m.url, monitorId }));
      await notifyChannels(
        m.channels,
        pulseChat({
          status: "warn",
          title: `Monitoring ended — ${m.name}`,
          mentions: await monitorChatMentions(m),
          rows: [
            ["URL", m.url],
            ["Note", `Archived now; permanently deleted in ${PURGE_AFTER_DAYS} days unless restored.`],
          ],
          button: { text: "Restore monitor", url: chatMonitorLink(monitorId) },
        }),
      );
      logger.info({ monitorId: String(m._id) }, "Monitor soft-deleted (period ended)");
    } else if (REMINDER_DAYS.includes(daysRemaining) && !(m.expiryRemindersSent ?? []).includes(daysRemaining)) {
      await Monitor.updateOne({ _id: m._id }, { $addToSet: { expiryRemindersSent: daysRemaining } });
      const to = await recipients(m);
      const monitorId = String(m._id);
      await sendEmail(monitorExpiringEmail({ to, monitorName: m.name, url: m.url, daysRemaining, expiresAt: exp.toISOString(), monitorId }));
      await notifyChannels(
        m.channels,
        pulseChat({
          status: "warn",
          title: `Monitoring ends in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`,
          subtitle: m.name,
          mentions: await monitorChatMentions(m),
          rows: [
            ["URL", m.url],
            ["Ends on", shortDate(exp)],
          ],
          button: { text: "Extend monitoring", url: chatMonitorLink(monitorId) },
        }),
      );
      logger.info({ monitorId: String(m._id), daysRemaining }, "Expiry reminder sent");
    }
  }

  // 2) Domain registration expiry — refresh ~daily via RDAP, warn at thresholds.
  // Applies to Full + Domain-only monitors; SSL-only monitors don't track domain.
  const live = (await Monitor.find({ softDeletedAt: null, enabled: true }).lean()) as unknown as LifecycleMonitor[];
  for (const m of live) {
    if (m.monitoringScope === "ssl") continue; // SSL-only: no domain monitoring
    let expiresAt = m.domainExpiresAt ? new Date(m.domainExpiresAt) : null;
    const stale =
      !m.domainCheckedAt || now.getTime() - new Date(m.domainCheckedAt).getTime() > DOMAIN_REFRESH_MS;
    if (stale) {
      const probed = await probeDomainExpiry(m.url);
      if (probed) {
        // If the domain was renewed (expiry moved out), reset warnings so we alert again next cycle.
        const renewed = expiresAt && probed.getTime() > expiresAt.getTime() + DAY;
        await Monitor.updateOne(
          { _id: m._id },
          { domainCheckedAt: now, domainExpiresAt: probed, ...(renewed ? { domainWarnedThresholds: [] } : {}) },
        );
        if (renewed) m.domainWarnedThresholds = [];
        expiresAt = probed;
      } else {
        await Monitor.updateOne({ _id: m._id }, { domainCheckedAt: now });
      }
    }
    if (!expiresAt) continue;

    // Domain-only monitors run no uptime check — reflect domain health in status.
    if (m.monitoringScope === "domain") {
      await Monitor.updateOne({ _id: m._id }, { status: expiresAt.getTime() <= now.getTime() ? "down" : "operational" });
    }

    const days = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY);
    const warned = m.domainWarnedThresholds ?? [];
    const threshold = DOMAIN_WARN_DAYS.find((t) => days >= 0 && days <= t && !warned.includes(t));
    if (threshold != null) {
      await Monitor.updateOne({ _id: m._id }, { $addToSet: { domainWarnedThresholds: threshold } });
      const to = await recipients(m);
      let domain = m.url;
      try {
        domain = new URL(m.url).hostname.replace(/^www\./, "");
      } catch {
        /* keep url */
      }
      const project = await projectNameOf((m as { projectId?: unknown }).projectId);
      const monitorId = String(m._id);
      await sendEmail(
        domainExpiringEmail({ to, domain, monitorName: m.name, expiresAt: expiresAt.toISOString(), daysRemaining: days, monitorId, project }),
      );
      await notifyChannels(
        m.channels,
        pulseChat({
          status: "down",
          title: `Domain expiring in ${days} day${days === 1 ? "" : "s"}`,
          subtitle: domain,
          mentions: await monitorChatMentions(m),
          rows: [
            ["Monitor", m.name],
            ["Domain", domain],
            ["Expires", shortDate(expiresAt)],
          ],
          button: { text: "View monitor", url: chatMonitorLink(monitorId) },
        }),
      );
      void createNotifications(m.members ?? [], {
        type: "expiry",
        title: `Domain expiring on ${m.name}`,
        body: `Registration expires in ${days} day${days === 1 ? "" : "s"}.`,
        link: `/monitors/${monitorId}?tab=ssl`,
      });
      logger.info({ monitorId: String(m._id), days }, "Domain expiry warning sent");
    }
  }

  // 2b) SSL certificate expiry for SSL-only monitors. They run no uptime check,
  // so probe the cert here and reuse the shared expiry-warning logic.
  for (const m of live) {
    if (m.monitoringScope !== "ssl") continue;
    const expiry = await probeSslExpiry(m.url, m.timeoutMs ?? 10000);
    if (!expiry) {
      await Monitor.updateOne({ _id: m._id }, { status: "unknown" });
      continue;
    }
    await handleSslWarnings(m as unknown as MonitorWithId, expiry, now);
    await Monitor.updateOne({ _id: m._id }, { status: expiry.getTime() <= now.getTime() ? "down" : "operational" });
  }

  // 3) Permanently delete monitors soft-deleted more than PURGE_AFTER_DAYS ago (cascade).
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY);
  const toPurge = await Monitor.find({ softDeletedAt: { $ne: null, $lte: cutoff } }).select("_id").lean();
  for (const m of toPurge) {
    await purgeIncidentImagesFor([m._id]); // before deleting incident docs
    await Promise.all([
      Check.deleteMany({ monitorId: m._id }),
      Incident.deleteMany({ monitorId: m._id }),
      UptimeStat.deleteMany({ monitorId: m._id }),
      purgeMaintenanceFor({ monitorIds: [m._id] }),
    ]);
    await Monitor.deleteOne({ _id: m._id });
    logger.warn({ monitorId: String(m._id) }, "Monitor permanently deleted (purge)");
  }

  // 4) Sweep orphaned proof images (uploaded to an editor that was never saved).
  await sweepOrphanProofs();
}

/** Hourly lifecycle cron. Reminders dedupe per day so hourly runs are safe. */
export function startLifecycle(): ScheduledTask {
  logger.info("Renewals & cleanup job started - hourly (SSL/domain expiry, monitoring periods, purge)");
  const task = cron.schedule("0 * * * *", () => {
    runLifecycle().catch((err) => logger.error({ err }, "Renewals & cleanup pass failed"));
  });
  runLifecycle().catch((err) => logger.error({ err }, "Renewals & cleanup pass failed"));
  return task;
}
