import { config } from "../../config";
import { logger } from "../../config/logger";
import { sendViaSmtp } from "./smtp";
import { sendViaSes } from "./ses";
import { sendViaSendgrid } from "./sendgrid";
import { sendViaMailjet } from "./mailjet";
import { sendViaBrevo } from "./brevo";

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

/**
 * Single entry point for all notifications. Transport chosen by MAIL_DRIVER
 * (smtp = nodemailer, ses = AWS SES, sendgrid = SendGrid HTTP API,
 * mailjet = Mailjet HTTP API, console = log only). A send failure is
 * logged but never crashes monitoring.
 */
export interface SendResult {
  ok: boolean;
  /** Human-readable reason when ok=false (surfaced by the Test-notification endpoint). */
  error?: string;
}

export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  if (!msg.to.length) {
    logger.warn("No alert recipients; skipping email");
    return { ok: false, error: "No recipients" };
  }
  try {
    switch (config.mail.driver) {
      case "ses":
        await sendViaSes(msg);
        break;
      case "sendgrid":
        await sendViaSendgrid(msg);
        break;
      case "mailjet":
        await sendViaMailjet(msg);
        break;
      case "brevo":
        await sendViaBrevo(msg);
        break;
      case "console":
        logger.info({ to: msg.to, subject: msg.subject, body: msg.text }, "📧 Email (console driver)");
        break;
      default:
        await sendViaSmtp(msg);
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err, driver: config.mail.driver, from: config.mail.from, subject: msg.subject }, "Failed to send email");
    return { ok: false, error: `[${config.mail.driver}] ${error}` };
  }
}

export * from "./templates";
