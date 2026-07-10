import { User } from "../models/user.model";
import { Monitor } from "../models/monitor.model";
import { logger } from "../config/logger";
import { config } from "../config";
import { sendEmail, incidentMentionEmail } from "./mailer";
import { notifyChannels, chatMonitorLink } from "./channels";
import { projectNameOf } from "../utils/projectName";

/**
 * Notify newly @-mentioned users on an incident note, Jira-style: an email +
 * a Google Chat ping in the monitor's channels. Fire-and-forget — call it
 * AFTER the HTTP response is sent; it never throws and never blocks the save.
 */
export async function notifyIncidentMentions(opts: {
  incidentId: string;
  monitorId: unknown;
  actorId: string;
  actorName: string;
  newUserIds: string[];
}): Promise<void> {
  try {
    const targets = [...new Set(opts.newUserIds)].filter((id) => id && id !== opts.actorId); // never notify yourself
    if (!targets.length) return;

    const monitor = await Monitor.findById(opts.monitorId).lean();
    if (!monitor) return;

    const users = await User.find({ _id: { $in: targets } }).select("email googleId").lean();
    if (!users.length) return;

    const emails = users.map((u) => u.email).filter(Boolean);
    const project = await projectNameOf(monitor.projectId);
    const monitorId = String(monitor._id);
    const incidentUrl = config.appBaseUrl ? `${config.appBaseUrl}/monitors/${monitorId}` : null;

    // Chat: ping only the newly-tagged users who signed in with Google.
    const chatMentions = users
      .filter((u) => u.googleId)
      .map((u) => `<users/${u.googleId}>`)
      .join(" ");
    const link = chatMonitorLink(monitorId);
    const chatText = [
      chatMentions,
      `💬 ${opts.actorName} mentioned you in an incident note on *${monitor.name}*.`,
      link ? `Check the monitor at ${link}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await Promise.allSettled([
      emails.length
        ? sendEmail(incidentMentionEmail({ to: emails, monitorName: monitor.name, actorName: opts.actorName, incidentUrl, project }))
        : Promise.resolve(),
      chatMentions ? notifyChannels(monitor.channels as unknown[] | undefined, { text: chatText }) : Promise.resolve(),
    ]);
    logger.info({ incidentId: opts.incidentId, count: targets.length }, "Notified newly-mentioned users on incident note");
  } catch (err) {
    logger.error({ err }, "Failed to notify incident mentions");
  }
}
