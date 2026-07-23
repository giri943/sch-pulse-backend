import { User } from "../models/user.model";
import { logger } from "../config/logger";
import { config } from "../config";
import { sendEmail, sopReminderEmail } from "./mailer";
import { notifyChannels } from "./channels";
import { createNotifications } from "./notify";

/** One SOP that needs attention, with its effective owner (SOP owner → maintenance owner). */
export interface SopDigestItem {
  name: string;
  periodLabel: string;
  ownerId: string | null;
}

export interface SopDigest {
  projectId: string;
  projectName: string;
  channels?: unknown[];
  upcoming: SopDigestItem[];
  overdue: SopDigestItem[];
}

/**
 * Fan a project's SOP upcoming/overdue digest out over email (to the owners),
 * Google Chat (to the project's channels), and the in-app bell. Fire-and-forget;
 * never throws — a delivery failure must not stall the lifecycle cron.
 */
export async function sendSopDigest(d: SopDigest): Promise<void> {
  try {
    const items = [...d.overdue, ...d.upcoming];
    if (!items.length) return;

    const ownerIds = [...new Set(items.map((i) => i.ownerId).filter((x): x is string => !!x))];
    const owners = ownerIds.length ? await User.find({ _id: { $in: ownerIds } }).select("email googleId").lean() : [];
    const emails = owners.map((u) => u.email).filter(Boolean);

    const link = config.appBaseUrl ? `${config.appBaseUrl}/projects/${d.projectId}?tab=servicelog` : "/projects";
    const tasks: Promise<unknown>[] = [];

    // Email digest → the owners responsible.
    if (emails.length) {
      tasks.push(
        sendEmail(
          sopReminderEmail({
            to: emails,
            projectName: d.projectName,
            projectId: d.projectId,
            upcoming: d.upcoming.map((i) => ({ name: i.name, period: i.periodLabel })),
            overdue: d.overdue.map((i) => ({ name: i.name, period: i.periodLabel })),
          }),
        ),
      );
    }

    // Google Chat → the project's channel(s), @mentioning the owners.
    if (d.channels?.length) {
      const mentions = owners.filter((u) => u.googleId).map((u) => `<users/${u.googleId}>`).join(" ");
      const lines: string[] = [];
      if (d.overdue.length) {
        lines.push(`*⚠️ Overdue (${d.overdue.length}):*`);
        d.overdue.forEach((i) => lines.push(`• ${i.name} — ${i.periodLabel}`));
      }
      if (d.upcoming.length) {
        lines.push(`*⏳ Due soon (${d.upcoming.length}):*`);
        d.upcoming.forEach((i) => lines.push(`• ${i.name} — ${i.periodLabel}`));
      }
      const text = [
        mentions,
        `🛠️ *${d.projectName}* — server-maintenance tasks need attention:`,
        lines.join("\n"),
        `Open the service log: ${link}`,
      ]
        .filter(Boolean)
        .join("\n");
      tasks.push(notifyChannels(d.channels, { text }));
    }

    // In-app bell → the owners.
    if (ownerIds.length) {
      const parts = [d.overdue.length ? `${d.overdue.length} overdue` : "", d.upcoming.length ? `${d.upcoming.length} due soon` : ""].filter(Boolean);
      tasks.push(
        createNotifications(ownerIds, {
          type: "maintenance",
          title: `Maintenance tasks on ${d.projectName}`,
          body: parts.join(" · "),
          link: `/projects/${d.projectId}?tab=servicelog`,
        }),
      );
    }

    await Promise.allSettled(tasks);
    logger.info({ projectId: d.projectId, upcoming: d.upcoming.length, overdue: d.overdue.length }, "Sent SOP maintenance digest");
  } catch (err) {
    logger.error({ err, projectId: d.projectId }, "Failed to send SOP maintenance digest");
  }
}
