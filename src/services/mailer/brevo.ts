import { config } from "../../config";
import { logger } from "../../config/logger";
import { postJsonWithRetry } from "./httpSend";
import type { EmailMessage } from "./index";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

/**
 * Brevo (ex-Sendinblue) driver — used when MAIL_DRIVER=brevo. Uses Brevo's
 * transactional email HTTP API over HTTPS. Like Mailjet you only need to
 * validate a single sender (no DNS), but it runs on a different endpoint that
 * isn't reset by Render's egress. Requires BREVO_API_KEY + a validated MAIL_FROM.
 * Transient network errors are retried.
 */
export async function sendViaBrevo(msg: EmailMessage): Promise<void> {
  const apiKey = config.mail.brevoApiKey;
  if (!apiKey) throw new Error("BREVO_API_KEY is not set");

  await postJsonWithRetry(BREVO_URL, {
    label: "Brevo",
    headers: { "api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: config.mail.from, name: "Schbang Pulse" },
      to: msg.to.map((email) => ({ email })),
      subject: msg.subject,
      htmlContent: msg.html,
      textContent: msg.text,
    }),
  });
  logger.info({ to: msg.to, subject: msg.subject }, "📧 Email sent (brevo)");
}
