import type { ChatMessage } from "./index";
import { config } from "../../config";

/**
 * Google Chat cardsV2 builder for Pulse alerts — a header with a status emoji,
 * a section of label/value rows, and an optional "open" button. A plain-text
 * summary always accompanies the card (preview + delivery fallback).
 */

type Status = "down" | "up" | "warn" | "info";
const EMOJI: Record<Status, string> = { down: "🔴", up: "🟢", warn: "⚠️", info: "🔔" };

export const chatMonitorLink = (id?: string): string | null =>
  id && config.appBaseUrl ? `${config.appBaseUrl}/monitors/${id}` : null;

export interface PulseChatOpts {
  status: Status;
  title: string;
  subtitle?: string;
  rows: [string, string | null | undefined][];
  button?: { text: string; url: string | null };
  /** Pre-rendered Google Chat @mentions (e.g. "<users/123> <users/456>"). */
  mentions?: string;
}

export function pulseChat(o: PulseChatOpts): ChatMessage {
  const emoji = EMOJI[o.status];
  const rows = o.rows.filter(([, v]) => v != null && v !== "") as [string, string][];

  const widgets: Record<string, unknown>[] = rows.map(([topLabel, text]) => ({
    decoratedText: { topLabel, text, wrapText: true },
  }));
  if (o.button?.url) {
    widgets.push({
      buttonList: { buttons: [{ text: o.button.text, onClick: { openLink: { url: o.button.url } } }] },
    });
  }

  // Plain-text fallback/preview (Google Chat markdown: *bold*).
  const textLines = [
    `${emoji} *${o.title}*${o.subtitle ? ` — ${o.subtitle}` : ""}`,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    o.button?.url ? o.button.url : "",
  ].filter(Boolean);
  const text = `${o.mentions ? o.mentions + "\n" : ""}${textLines.join("\n")}`;

  return {
    text,
    card: {
      cardId: "pulse-alert",
      card: {
        header: { title: `${emoji} ${o.title}`, subtitle: o.subtitle ?? "" },
        sections: [{ widgets }],
      },
    },
  };
}
