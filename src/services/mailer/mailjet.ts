import { config } from "../../config";
import { logger } from "../../config/logger";
import type { EmailMessage } from "./index";

const MAILJET_URL = "https://api.mailjet.com/v3.1/send";

/**
 * Mailjet driver — used when MAIL_DRIVER=mailjet. Uses Mailjet's Send API v3.1
 * over HTTPS (works on hosts that block SMTP, e.g. Render). Requires
 * MAILJET_API_KEY + MAILJET_SECRET_KEY and a validated MAIL_FROM sender.
 */
export async function sendViaMailjet(msg: EmailMessage): Promise<void> {
  const { apiKey, secretKey } = config.mail.mailjet;
  if (!apiKey || !secretKey) throw new Error("MAILJET_API_KEY / MAILJET_SECRET_KEY are not set");

  const auth = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(MAILJET_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        Messages: [
          {
            From: { Email: config.mail.from, Name: "Schbang Pulse" },
            To: msg.to.map((email) => ({ Email: email })),
            Subject: msg.subject,
            TextPart: msg.text,
            HTMLPart: msg.html,
          },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Mailjet responded ${res.status}: ${detail.slice(0, 300)}`);
    }
    logger.info({ to: msg.to, subject: msg.subject }, "📧 Email sent (mailjet)");
  } finally {
    clearTimeout(timer);
  }
}
