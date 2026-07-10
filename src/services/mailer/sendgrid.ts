import { config } from "../../config";
import { logger } from "../../config/logger";
import { postJsonWithRetry } from "./httpSend";
import type { EmailMessage } from "./index";

const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

/**
 * SendGrid driver — used when MAIL_DRIVER=sendgrid. Uses SendGrid's v3 HTTP API
 * over HTTPS (port 443), so it works on hosts that block outbound SMTP (e.g.
 * Render). Requires SENDGRID_API_KEY and a verified MAIL_FROM sender.
 * Transient network errors (e.g. ECONNRESET on Render) are retried.
 */
export async function sendViaSendgrid(msg: EmailMessage): Promise<void> {
  const apiKey = config.mail.sendgridApiKey;
  if (!apiKey) throw new Error("SENDGRID_API_KEY is not set");

  await postJsonWithRetry(SENDGRID_URL, {
    label: "SendGrid",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: msg.to.map((email) => ({ email })) }],
      from: { email: config.mail.from },
      subject: msg.subject,
      content: [
        { type: "text/plain", value: msg.text },
        { type: "text/html", value: msg.html },
      ],
    }),
  });
  logger.info({ to: msg.to, subject: msg.subject }, "Email sent (sendgrid)");
}
