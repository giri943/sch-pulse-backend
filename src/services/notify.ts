import { Notification, type NOTIFICATION_TYPES } from "../models/notification.model";
import { logger } from "../config/logger";
import { publish } from "./realtime";

type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Create an in-app notification for each recipient and nudge their bell live.
 * Fire-and-forget; never throws. Dedupes recipients and can exclude the actor
 * (so you're never notified about your own action).
 */
export async function createNotifications(
  userIds: unknown[],
  payload: { type: NotificationType; title: string; body?: string; link?: string | null },
  opts?: { excludeUserId?: string },
): Promise<void> {
  try {
    const ids = [...new Set(userIds.map((u) => String(u)))].filter((id) => id && id !== opts?.excludeUserId);
    if (!ids.length) return;
    await Notification.insertMany(
      ids.map((userId) => ({ userId, type: payload.type, title: payload.title, body: payload.body ?? "", link: payload.link ?? null })),
    );
    publish("notifications"); // clients refetch their own list
  } catch (err) {
    logger.error({ err }, "Failed to create notifications");
  }
}
