import { User } from "../models/user.model";
import { Monitor } from "../models/monitor.model";
import { logger } from "../config/logger";
import { sendEmail, maintenanceMentionEmail } from "./mailer";
import { notifyChannels, chatMonitorLink } from "./channels";
import { projectNameOf } from "../utils/projectName";
import { createNotifications } from "./notify";

/**
 * Notify users @-tagged in a maintenance window's note (email + Google Chat for
 * monitor-scope windows with channels). Fire-and-forget; never throws.
 */
export async function notifyMaintenanceMentions(opts: {
  scope: "monitor" | "project";
  monitorId?: unknown;
  projectId?: unknown;
  actorId: string;
  actorName: string;
  userIds: string[];
  startAt: Date;
  endAt: Date;
  reason: string;
}): Promise<void> {
  try {
    const targets = [...new Set(opts.userIds)].filter((id) => id && id !== opts.actorId);
    if (!targets.length) return;

    const users = await User.find({ _id: { $in: targets } }).select("email googleId").lean();
    if (!users.length) return;
    const emails = users.map((u) => u.email).filter(Boolean);

    let targetName = "a project";
    let monitorId: string | null = null;
    let channels: unknown[] | undefined;
    if (opts.scope === "monitor" && opts.monitorId) {
      const m = await Monitor.findById(opts.monitorId).lean();
      if (m) {
        targetName = m.name;
        monitorId = String(m._id);
        channels = m.channels as unknown[] | undefined;
      }
    } else if (opts.projectId) {
      targetName = (await projectNameOf(opts.projectId)) ?? "a project";
    }

    const note = opts.reason.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    const link = monitorId ? chatMonitorLink(monitorId) : null;

    const tasks: Promise<unknown>[] = [];
    if (emails.length) {
      tasks.push(
        sendEmail(maintenanceMentionEmail({ to: emails, actorName: opts.actorName, targetName, scope: opts.scope, startAt: opts.startAt.toISOString(), endAt: opts.endAt.toISOString(), note, link })),
      );
    }
    if (channels?.length) {
      const gm = users.filter((u) => u.googleId).map((u) => `<users/${u.googleId}>`).join(" ");
      if (gm) {
        const text = [gm, `🛠️ ${opts.actorName} scheduled maintenance on *${targetName}* and tagged you.`, link ? `Details: ${link}` : ""].filter(Boolean).join("\n");
        tasks.push(notifyChannels(channels, { text }));
      }
    }
    await Promise.allSettled(tasks);
    await createNotifications(targets, {
      type: "mention",
      title: `${opts.actorName} tagged you in maintenance`,
      body: `On ${targetName}`,
      link: monitorId ? `/monitors/${monitorId}?tab=maintenance` : "/projects",
    });
    logger.info({ count: targets.length }, "Notified users tagged on maintenance window");
  } catch (err) {
    logger.error({ err }, "Failed to notify maintenance mentions");
  }
}
