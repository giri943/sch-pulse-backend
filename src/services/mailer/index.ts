import { config } from "../../config";
import { logger } from "../../config/logger";
import { sendViaSmtp } from "./smtp";
import { sendViaSes } from "./ses";

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

/**
 * Single entry point for all notifications. Transport chosen by MAIL_DRIVER
 * (smtp = nodemailer, ses = AWS SES, console = log only). A send failure is
 * logged but never crashes monitoring.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (!msg.to.length) {
    logger.warn("No alert recipients; skipping email");
    return;
  }
  try {
    switch (config.mail.driver) {
      case "ses":
        await sendViaSes(msg);
        break;
      case "console":
        logger.info({ to: msg.to, subject: msg.subject, body: msg.text }, "📧 Email (console driver)");
        break;
      default:
        await sendViaSmtp(msg);
    }
  } catch (err) {
    logger.error({ err, subject: msg.subject }, "Failed to send email");
  }
}

export * from "./templates";
