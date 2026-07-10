import cron, { type ScheduledTask } from "node-cron";
import { Incident } from "../../models/incident.model";
import { Monitor } from "../../models/monitor.model";
import { User } from "../../models/user.model";
import { EscalationPolicy } from "../../models/escalationPolicy.model";
import { logger } from "../../config/logger";
import { sendEmail, incidentEscalationEmail, formatDuration } from "../mailer";
import { notifyChannels, chatMonitorLink } from "../channels";
import { projectNameOf } from "../../utils/projectName";
import { monitorChatMentions } from "../../utils/mentions";
import { humanizeError } from "../../utils/humanizeError";

// Re-entrancy guard — skip a tick if the previous pass is still running.
let running = false;

/**
 * Post-incident lifecycle pass. Currently: escalate incidents left open past the
 * configured threshold. (RCA reminders will hook in here too.) Off unless a
 * super-admin has enabled an escalation policy — so it's a no-op by default.
 */
export async function runIncidentLifecycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await escalateOverdueIncidents();
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

/** Every 2 minutes — fine-grained enough for minute-based escalation thresholds. */
export function startIncidentLifecycle(): ScheduledTask {
  logger.info("Incident escalation watcher started - checking open incidents every 2 min");
  const task = cron.schedule("*/2 * * * *", () => {
    runIncidentLifecycle().catch((err) => logger.error({ err }, "Escalation check failed"));
  });
  return task;
}
