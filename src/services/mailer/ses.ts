import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { config } from "../../config";
import { logger } from "../../config/logger";
import type { EmailMessage } from "./index";

let client: SESClient | null = null;
const getClient = (): SESClient => (client ??= new SESClient({ region: config.aws.region }));

/** AWS SES driver — used when MAIL_DRIVER=ses (production). */
export async function sendViaSes(msg: EmailMessage): Promise<void> {
  await getClient().send(
    new SendEmailCommand({
      Source: config.aws.sesFrom,
      Destination: { ToAddresses: msg.to },
      Message: {
        Subject: { Data: msg.subject },
        Body: { Html: { Data: msg.html }, Text: { Data: msg.text } },
      },
    }),
  );
  logger.info({ to: msg.to, subject: msg.subject }, "📧 Email sent (ses)");
}
