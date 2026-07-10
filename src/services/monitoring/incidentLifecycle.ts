import cron, { type ScheduledTask } from "node-cron";
import { Incident } from "../../models/incident.model";
import { Monitor } from "../../models/monitor.model";
import { User } from "../../models/user.model";
import { ProjectMember } from "../../models/projectMember.model";
import { EscalationPolicy } from "../../models/escalationPolicy.model";
import { RcaReminderPolicy } from "../../models/rcaReminderPolicy.model";
import { logger } from "../../config/logger";
import { sendEmail, incidentEscalationEmail, rcaReminderEmail, formatDuration } from "../mailer";
import { notifyChannels, chatMonitorLink } from "../channels";
import { projectNameOf } from "../../utils/projectName";
import { monitorChatMentions } from "../../utils/mentions";
import { humanizeError } from "../../utils/humanizeError";
import { isEmptyNote } from "../../utils/sanitizeNotes";

// Re-entrancy guard — skip a tick if the previous pass is still running.
let running = false;

/**
 * Post-incident lifecycle pass, run every 2 minutes:
 *  1. Escalate incidents left open past the configured threshold (only when a
 *     super-admin has enabled the escalation policy — a no-op by default).
 *  2. Remind owners/members to write a root-cause analysis on resolved
 *     incidents that still have none (daily, for up to 7 days).
 */
export async function runIncidentLifecycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await escalateOverdueIncidents();
    await remindPendingRcas();
  } finally {
    running = false;
  }
}

async function escalateOverdueIncidents(): Promise<void> {
  const policy = await EscalationPolicy.findOne({ key: "global" }).lean();
  if (!policy?.enabled || !policy.emails?.length) return; // feature off / no leadership configured

  const afterMinutes = policy.afterMinutes ?? 60;
  const cutoff = new Date(Date.now() - afterMinutes * 60_000);

  // Open incidents older than the threshold that haven't fired this tier yet.
  const due = await Incident.find({
    status: "open",
    startedAt: { $lte: cutoff },
    escalationsSent: { $ne: afterMinutes },
  })
    .sort({ startedAt: 1 })
    .limit(50)
    .lean();

  for (const inc of due) {
    const monitor = await Monitor.findById(inc.monitorId).lean();
    if (!monitor) continue;

    const downtime = formatDuration(Math.round((Date.now() - new Date(inc.startedAt).getTime()) / 1000));
    const human = humanizeError({ statusCode: inc.trigger?.statusCode, error: inc.trigger?.error, server: inc.trigger?.server });

    // Recipients = leadership + the monitor's normal alertees (so the team sees it escalated).
    const memberIds = (monitor.members as unknown[] | undefined) ?? [];
    const memberUsers = memberIds.length ? await User.find({ _id: { $in: memberIds } }).select("email").lean() : [];
    const to = [
      ...new Set([
        ...policy.emails,
        ...memberUsers.map((u) => u.email).filter(Boolean),
        ...((monitor.extraAlertEmails as string[] | undefined) ?? []),
      ]),
    ];

    const project = await projectNameOf(monitor.projectId);
    const monitorId = String(monitor._id);

    // Chat: a plain escalation notification (no card) — just says it's escalated.
    const mentions = await monitorChatMentions(monitor);
    const link = chatMonitorLink(monitorId);
    const chatText = [
      mentions,
      `🚨 *${monitor.name}* has been escalated to leadership — this incident has been unresolved for ${downtime}.`,
      link ? `Check the monitor at ${link}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await Promise.allSettled([
      sendEmail(
        incidentEscalationEmail({ to, monitorName: monitor.name, url: monitor.url, downtime, afterMinutes, whatThisMeans: human, monitorId, project }),
      ),
      notifyChannels(monitor.channels as unknown[] | undefined, { text: chatText }),
    ]);

    // Mark this tier fired — only if still open (avoids escalating a just-resolved one).
    await Incident.updateOne({ _id: inc._id, status: "open" }, { $addToSet: { escalationsSent: afterMinutes } });
    logger.warn({ monitorId, incidentId: String(inc._id), afterMinutes }, "Incident escalated to leadership");
  }
}

/**
 * Nudge the team to write a root-cause analysis on resolved incidents that
 * still have none. Cadence (everyHours) and how long to keep nudging (windowDays)
 * are configured by a super-admin via the RCA-reminder policy — defaults to once
 * per 24h, for up to 7 days. Can be turned off entirely from that policy.
 */
async function remindPendingRcas(): Promise<void> {
  // Cadence + window are configurable by a super-admin (defaults: every 24h, 7-day window).
  const policy = await RcaReminderPolicy.findOne({ key: "global" }).lean();
  if (policy && policy.enabled === false) return; // feature explicitly disabled
  const everyMs = (policy?.everyMinutes ?? 24 * 60) * 60_000;
  const windowMs = (policy?.windowMinutes ?? 7 * 24 * 60) * 60_000;

  const now = Date.now();
  const due = await Incident.find({
    status: "resolved",
    // Resolved within the window but at least one cadence-interval ago (old enough to expect an RCA).
    resolvedAt: { $gte: new Date(now - windowMs), $lte: new Date(now - everyMs) },
    // Never nudged, or last nudge was at least one cadence-interval ago.
    $or: [{ lastRcaReminderAt: null }, { lastRcaReminderAt: { $lte: new Date(now - everyMs) } }],
  })
    .sort({ resolvedAt: 1 })
    .limit(50)
    .lean();

  for (const inc of due) {
    if (!isEmptyNote(inc.rootCauseNotes)) continue; // RCA already written — nothing to nudge
    const monitor = await Monitor.findById(inc.monitorId).lean();
    if (!monitor) continue;

    // Recipients: the project owner(s) + the monitor's tagged members.
    const recipientIds = new Set<string>();
    if (monitor.projectId) {
      const owners = await ProjectMember.find({ projectId: monitor.projectId, role: "owner" }).select("userId").lean();
      owners.forEach((o) => recipientIds.add(String(o.userId)));
    }
    ((monitor.members as unknown[] | undefined) ?? []).forEach((m) => recipientIds.add(String(m)));
    const users = recipientIds.size ? await User.find({ _id: { $in: [...recipientIds] } }).select("email").lean() : [];
    const to = [...new Set(users.map((u) => u.email).filter(Boolean))];

    const project = await projectNameOf(monitor.projectId);
    const monitorId = String(monitor._id);
    const link = chatMonitorLink(monitorId);

    const mentions = await monitorChatMentions(monitor);
    const chatText = [
      mentions,
      `📝 *${monitor.name}* — this incident resolved but still has no root-cause analysis. Please add one so we capture what happened.`,
      link ? `Add it at ${link}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await Promise.allSettled([
      to.length
        ? sendEmail(rcaReminderEmail({ to, monitorName: monitor.name, resolvedAt: new Date(inc.resolvedAt!).toISOString(), incidentUrl: link, project }))
        : Promise.resolve(),
      notifyChannels(monitor.channels as unknown[] | undefined, { text: chatText }),
    ]);

    await Incident.updateOne({ _id: inc._id }, { $set: { lastRcaReminderAt: new Date() } });
    logger.info({ monitorId, incidentId: String(inc._id) }, "RCA reminder sent (root cause still pending)");
  }
}

/** Every 2 minutes — fine-grained enough for minute-based escalation thresholds. */
export function startIncidentLifecycle(): ScheduledTask {
  logger.info("Incident escalation watcher started - checking open incidents every 2 min");
  const task = cron.schedule("*/2 * * * *", () => {
    runIncidentLifecycle().catch((err) => logger.error({ err }, "Escalation check failed"));
  });
  return task;
}
