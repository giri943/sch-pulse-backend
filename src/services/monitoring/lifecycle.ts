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
import { fmtDateIST } from "../../utils/datetime";

const shortDate = fmtDateIST;
import { probeDomainExpiry, apexOf } from "./domainProbe";
import { probeSslExpiry } from "./sslProbe";
import { handleSslWarnings } from "./incident";
import { purgeMaintenanceFor, purgeIncidentImagesFor, sweepOrphanProofs } from "../maintenanceCleanup";
import { createNotifications } from "../notify";
import { ProjectSop } from "../../models/projectSop.model";
import { SopCompletion } from "../../models/sopCompletion.model";
import { Project } from "../../models/project.model";
import { periodKey, periodLabel, isDueWindow, periodStart, prevPeriodKey } from "../../utils/sopPeriod";
import { sendSopDigest, type SopDigestItem } from "../sopNotify";
import type { SopFrequency } from "../../utils/constants";
import type { MonitorWithId } from "./types";
import { DOMAIN_WARN_DAYS } from "../../utils/constants";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const REMINDER_DAYS = [3, 2, 1]; // daily reminders in the final 3 days
const PURGE_AFTER_DAYS = 7; // hard-delete this long after soft-delete

// Tiered RDAP refresh. An expiry date is stable, so only domains approaching
// expiry need daily attention. The hot window is wider than the first warning
// threshold (30d) so there is retry headroom before an alert relies on it.
const DOMAIN_HOT_WINDOW_DAYS = 45;
const DOMAIN_HOT_INTERVAL_MS = 20 * HOUR;
const DOMAIN_COLD_INTERVAL_MS = 30 * DAY;
const DOMAIN_UNKNOWN_INTERVAL_MS = 6 * HOUR;
// rdap.org throttles at ~10 back-to-back requests; 1.5s spacing measured clean.
const RDAP_DELAY_MS = 1500;
const MAX_DOMAIN_PROBES_PER_RUN = 20;

export interface LifecycleMonitor {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function domainRefreshIntervalMs(expiresAt: Date | null, now: Date): number {
  if (!expiresAt) return DOMAIN_UNKNOWN_INTERVAL_MS;
  const days = (expiresAt.getTime() - now.getTime()) / DAY;
  return days <= DOMAIN_HOT_WINDOW_DAYS ? DOMAIN_HOT_INTERVAL_MS : DOMAIN_COLD_INTERVAL_MS;
}

export interface DomainRefreshStats {
  monitors: number;
  due: number;
  probed: number;
  updated: number;
  rateLimited: boolean;
  capped: boolean;
}

/**
 * Probe the apex domains that are due, one request per domain regardless of how
 * many monitors share it. Returns the fresh expiries keyed by apex.
 */
export async function refreshDomainExpiries(
  monitors: LifecycleMonitor[],
  now: Date,
  stats?: DomainRefreshStats,
): Promise<Map<string, Date>> {
  const dueByApex = new Map<string, LifecycleMonitor[]>();
  for (const m of monitors) {
    const apex = apexOf(m.url);
    if (!apex) continue;
    const expiresAt = m.domainExpiresAt ? new Date(m.domainExpiresAt) : null;
    const checkedAt = m.domainCheckedAt ? new Date(m.domainCheckedAt).getTime() : 0;
    if (now.getTime() - checkedAt < domainRefreshIntervalMs(expiresAt, now)) continue;
    const group = dueByApex.get(apex);
    if (group) group.push(m);
    else dueByApex.set(apex, [m]);
  }

  if (stats) {
    stats.monitors = monitors.length;
    stats.due = dueByApex.size;
  }
  if (!dueByApex.size) return new Map();

  const fresh = new Map<string, Date>();
  let probed = 0;
  let updated = 0;
  for (const [apex, group] of dueByApex) {
    if (probed >= MAX_DOMAIN_PROBES_PER_RUN) {
      if (stats) stats.capped = true;
      logger.info({ deferred: dueByApex.size - probed }, "Domain probe cap reached - rest deferred to next run");
      break;
    }
    if (probed > 0) await sleep(RDAP_DELAY_MS);
    const res = await probeDomainExpiry(group[0].url);
    probed++;

    if (res.ok) {
      fresh.set(apex, res.expiresAt);
      const ids = group.map((g) => g._id);
      const renewedIds = group
        .filter((g) => g.domainExpiresAt && res.expiresAt.getTime() > new Date(g.domainExpiresAt).getTime() + DAY)
        .map((g) => g._id);
      await Monitor.updateMany({ _id: { $in: ids } }, { domainCheckedAt: now, domainExpiresAt: res.expiresAt });
      if (renewedIds.length) await Monitor.updateMany({ _id: { $in: renewedIds } }, { domainWarnedThresholds: [] });
      updated += ids.length;
      continue;
    }

    // Throttled: leave domainCheckedAt alone so these retry next run, and stop
    // probing — the remaining requests would be throttled too.
    if (res.reason === "rate_limited") {
      if (stats) stats.rateLimited = true;
      logger.warn({ apex, probed, deferred: dueByApex.size - probed }, "RDAP rate-limited - deferring rest of this run");
      break;
    }
    await Monitor.updateMany({ _id: { $in: group.map((g) => g._id) } }, { domainCheckedAt: now });
  }

  if (stats) {
    stats.probed = probed;
    stats.updated = updated;
  }
  logger.info({ probed, due: dueByApex.size, monitors: monitors.length }, "Domain expiry refresh complete");
  return fresh;
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

  // 2) Domain registration expiry — tiered RDAP refresh, then warn at thresholds.
  // Applies to Full + Domain-only monitors; SSL-only monitors don't track domain.
  const live = (await Monitor.find({ softDeletedAt: null, enabled: true }).lean()) as unknown as LifecycleMonitor[];
  const domainMonitors = live.filter((m) => m.monitoringScope !== "ssl");
  const freshExpiry = await refreshDomainExpiries(domainMonitors, now);

  for (const m of domainMonitors) {
    const apex = apexOf(m.url);
    const probed = apex ? freshExpiry.get(apex) : undefined;
    if (probed) {
      // Renewal moved the expiry out — clear warnings so later thresholds alert again.
      const previous = m.domainExpiresAt ? new Date(m.domainExpiresAt) : null;
      if (previous && probed.getTime() > previous.getTime() + DAY) m.domainWarnedThresholds = [];
      m.domainExpiresAt = probed;
    }
    const expiresAt = m.domainExpiresAt ? new Date(m.domainExpiresAt) : null;
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

  // 5) SOP maintenance reminders — per project, nudge owners about tasks that are
  // "due soon" (current period, in its due window) and "overdue" (last period was
  // missed). Delivered as one digest per project over email + Google Chat + the
  // in-app bell. Everything keys off each project's OWN SOP frequency (never the
  // library default) and dedupes per period so hourly runs don't spam.
  await remindMaintenanceSops(now);
}

async function remindMaintenanceSops(now: Date): Promise<void> {
  const projects = await Project.find({ hasServerMaintenance: true }).select("name maintenanceOwnerId channels").lean();
  for (const project of projects) {
    const sops = await ProjectSop.find({ projectId: project._id, active: true }).lean();
    if (!sops.length) continue;

    const upcoming: SopDigestItem[] = [];
    const overdue: SopDigestItem[] = [];
    const markUpcoming: { id: unknown; key: string }[] = [];
    const markOverdue: { id: unknown; key: string }[] = [];

    for (const s of sops) {
      const freq = s.frequency as SopFrequency; // the project's own cadence for this SOP
      const ownerId = s.ownerId ?? project.maintenanceOwnerId ?? null;

      // Due soon: current period, within its nudge window, not yet ticked off.
      const curKey = periodKey(freq, now);
      if (isDueWindow(freq, now) && s.lastRemindedPeriod !== curKey) {
        if (!(await SopCompletion.exists({ projectSopId: s._id, periodKey: curKey }))) {
          upcoming.push({ name: s.name, periodLabel: periodLabel(freq, curKey), ownerId: ownerId ? String(ownerId) : null });
          markUpcoming.push({ id: s._id, key: curKey });
        }
      }

      // Overdue: the previous period elapsed without a completion. Only if the SOP
      // already existed before this period began (so a freshly-attached SOP isn't
      // blamed for a period it wasn't part of).
      const prevKey = prevPeriodKey(freq, now);
      const createdAt = (s as { createdAt?: Date }).createdAt;
      const existedLastPeriod = !createdAt || createdAt < periodStart(freq, now);
      if (existedLastPeriod && s.lastOverduePeriod !== prevKey) {
        if (!(await SopCompletion.exists({ projectSopId: s._id, periodKey: prevKey }))) {
          overdue.push({ name: s.name, periodLabel: periodLabel(freq, prevKey), ownerId: ownerId ? String(ownerId) : null });
          markOverdue.push({ id: s._id, key: prevKey });
        }
      }
    }

    if (!upcoming.length && !overdue.length) continue;

    await sendSopDigest({
      projectId: String(project._id),
      projectName: project.name,
      channels: project.channels as unknown[] | undefined,
      upcoming,
      overdue,
    });

    // Mark as reminded only after dispatch, so a send failure retries next hour.
    await Promise.all([
      ...markUpcoming.map((u) => ProjectSop.updateOne({ _id: u.id }, { lastRemindedPeriod: u.key })),
      ...markOverdue.map((o) => ProjectSop.updateOne({ _id: o.id }, { lastOverduePeriod: o.key })),
    ]);
  }
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
