import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../../config";
import { logger } from "../../config/logger";
import type { EmailMessage } from "./index";

let transporter: Transporter | null = null;

/**
 * Lazily build the SMTP transport. If SMTP_HOST is set we use it (real delivery,
 * e.g. Gmail app password / Mailtrap). Otherwise we spin up a free Ethereal test
 * inbox so the demo works with zero config; each send logs a preview URL.
 */
async function getTransporter(): Promise<Transporter> {
  if (transporter) return transporter;

  if (config.mail.smtp.host) {
    transporter = nodemailer.createTransport({
      host: config.mail.smtp.host,
      port: config.mail.smtp.port,
      secure: config.mail.smtp.secure,
      auth: config.mail.smtp.user
        ? { user: config.mail.smtp.user, pass: config.mail.smtp.pass }
        : undefined,
    });
    logger.info({ host: config.mail.smtp.host }, "SMTP transport ready");
  } else {
    const test = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user: test.user, pass: test.pass },
    });
    logger.warn("No SMTP_HOST set — using Ethereal test inbox; preview URLs will be logged");
  }
  return transporter;
}

export async function sendViaSmtp(msg: EmailMessage): Promise<void> {
  const t = await getTransporter();
  const info = await t.sendMail({
    from: config.mail.from,
    to: msg.to.join(","),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  const preview = nodemailer.getTestMessageUrl(info);
  logger.info(
    { to: msg.to, subject: msg.subject, ...(preview ? { preview } : {}) },
    preview ? "📧 Email sent (open preview URL to view)" : "📧 Email sent (smtp)",
  );
}
