import { NotificationChannel } from "../../models/notificationChannel.model";
import { logger } from "../../config/logger";

/** A chat notification: rich card for display + plain text for the preview/fallback. */
export interface ChatMessage {
  /** Plain-text summary — used as the notification preview and the delivery fallback. */
  text: string;
  /** Optional Google Chat cardsV2 entry for rich display. */
  card?: Record<string, unknown>;
}

async function post(webhookUrl: string, body: unknown): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Google Chat webhook returned non-2xx");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to post to Google Chat");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post a message to a Google Chat space. When a card is present we send it with
 * the text; if the card is rejected (malformed schema, API change…), we retry
 * text-only so a critical alert is never lost to a presentation bug.
 */
export async function postGoogleChat(webhookUrl: string, message: ChatMessage | string): Promise<void> {
  const msg: ChatMessage = typeof message === "string" ? { text: message } : message;
  if (msg.card) {
    const ok = await post(webhookUrl, { text: msg.text, cardsV2: [msg.card] });
    if (!ok) await post(webhookUrl, { text: msg.text });
    return;
  }
  await post(webhookUrl, { text: msg.text });
}

/**
 * Fan a message out to a monitor's enabled channels. Never throws — channel
 * failures must not break monitoring. Accepts a plain string (treated as text)
 * or a full ChatMessage with a card.
 */
export async function notifyChannels(channelIds: unknown[] | undefined, message: ChatMessage | string): Promise<number> {
  if (!channelIds?.length) return 0;
  const msg: ChatMessage = typeof message === "string" ? { text: message } : message;
  try {
    const channels = await NotificationChannel.find({ _id: { $in: channelIds }, enabled: true }).lean();
    const dispatched = channels.filter((c) => c.type === "google_chat" && c.webhookUrl);
    await Promise.all(dispatched.map((c) => postGoogleChat(c.webhookUrl!, msg)));
    return dispatched.length;
  } catch (err) {
    logger.error({ err }, "Failed to dispatch channel notifications");
    return 0;
  }
}

export * from "./chatCards";
