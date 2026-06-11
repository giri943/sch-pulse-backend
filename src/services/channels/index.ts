import { NotificationChannel } from "../../models/notificationChannel.model";
import { logger } from "../../config/logger";

/** Post a plain-text message to a Google Chat space via its incoming webhook. */
export async function postGoogleChat(webhookUrl: string, text: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) logger.warn({ status: res.status }, "Google Chat webhook returned non-2xx");
  } catch (err) {
    logger.error({ err }, "Failed to post to Google Chat");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan a message out to a monitor's enabled channels. Never throws — channel
 * failures must not break monitoring.
 */
export async function notifyChannels(channelIds: unknown[] | undefined, text: string): Promise<number> {
  if (!channelIds?.length) return 0;
  try {
    const channels = await NotificationChannel.find({ _id: { $in: channelIds }, enabled: true }).lean();
    const dispatched = channels.filter((c) => c.type === "google_chat" && c.webhookUrl);
    await Promise.all(dispatched.map((c) => postGoogleChat(c.webhookUrl!, text)));
    return dispatched.length;
  } catch (err) {
    logger.error({ err }, "Failed to dispatch channel notifications");
    return 0;
  }
}
