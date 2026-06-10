import { Check } from "../../models/check.model";
import { Incident } from "../../models/incident.model";
import { Monitor } from "../../models/monitor.model";
import { User } from "../../models/user.model";
import { FAILURE_THRESHOLD, SSL_WARN_DAYS } from "../../utils/constants";
import { logger } from "../../config/logger";
import type { CheckResult, MonitorWithId } from "./types";
import { recordStat } from "./stats";
import { getRecommendations } from "../recommendations";
import { notifyChannels } from "../channels";
import {
  formatDuration,
  incidentOpenedEmail,
  incidentResolvedEmail,
  sendEmail,
  sslWarningEmail,
} from "../mailer";

/** Alert recipients = tagged members' emails + any extra free-text emails. */
async function alertRecipients(monitor: MonitorWithId): Promise<string[]> {
  const memberIds = (monitor.members as unknown[] | undefined) ?? [];
  let memberEmails: string[] = [];
  if (memberIds.length) {
    const users = await User.find({ _id: { $in: memberIds } }).select("email").lean();
    memberEmails = users.map((u) => u.email);
  }
  const extras = (monitor.extraAlertEmails as string[] | undefined) ?? [];
  return [...new Set([...memberEmails, ...extras])];
}

/**
 * Google Chat @mentions for tagged members who signed in with Google. Chat
 * mentions need the user's Google ID (we store it as `googleId`); email-only
 * users can't be mentioned. Returns e.g. "<users/123> <users/456>".
 */
async function memberMentions(monitor: MonitorWithId): Promise<string> {
  const memberIds = (monitor.members as unknown[] | undefined) ?? [];
  if (!memberIds.length) return "";
  const users = await User.find({ _id: { $in: memberIds }, googleId: { $ne: null } })
    .select("googleId")
    .lean();
  return users.map((u) => `<users/${u.googleId}>`).join(" ");
}

/**
 * Core monitoring outcome processor. Persists the raw check + hourly stat, then
 * runs the incident state machine. Idempotent w.r.t. the unique open-incident
 * index.
 */
export async function processResult(monitor: MonitorWithId, result: CheckResult): Promise<void> {
  const now = new Date();

  await Check.create({
    monitorId: monitor._id,
    checkedAt: now,
    up: result.up,
    statusCode: result.statusCode,
    responseTimeMs: result.responseTimeMs,
    error: result.error ?? null,
  });
  await recordStat(monitor._id, result, now);

  // SSL expiry is auto-tracked for any monitor whose check captured a certificate.
  if (result.sslExpiresAt) {
    await handleSslWarnings(monitor, result.sslExpiresAt, now);
  }

  if (result.up) await handleRecovery(monitor, result, now);
  else await handleFailure(monitor, result, now);
}

async function handleFailure(monitor: MonitorWithId, result: CheckResult, now: Date): Promise<void> {
  const failures = (monitor.consecutiveFailures ?? 0) + 1;
  const willOpen = failures >= FAILURE_THRESHOLD && !monitor.currentIncidentId;

  await Monitor.updateOne(
    { _id: monitor._id },
    {
      consecutiveFailures: failures,
      status: failures >= FAILURE_THRESHOLD ? "down" : "degraded",
      lastCheckedAt: now,
      lastResponseTimeMs: result.responseTimeMs,
    },
  );
  if (!willOpen) return;

  const recommendations = await getRecommendations({
    statusCode: result.statusCode,
    error: result.error,
    category: monitor.type === "ssl" ? "ssl" : monitor.type === "api" ? "api" : "web",
  });

  try {
    const incident = await Incident.create({
      monitorId: monitor._id,
      status: "open",
      startedAt: now,
      trigger: { statusCode: result.statusCode, error: result.error, responseTimeMs: result.responseTimeMs },
      recommendations,
      notifiedDown: true,
    });
    await Monitor.updateOne({ _id: monitor._id }, { currentIncidentId: incident._id });

    await sendEmail(
      incidentOpenedEmail({
        to: await alertRecipients(monitor),
        monitorName: monitor.name,
        url: monitor.url,
        error: result.error ?? "Check failed",
        statusCode: result.statusCode,
        timestamp: now.toISOString(),
        recommendations,
      }),
    );
    const mentions = await memberMentions(monitor);
    await notifyChannels(
      monitor.channels as unknown[] | undefined,
      `${mentions ? mentions + "\n" : ""}🔴 *DOWN* — ${monitor.name}\n${monitor.url}\nError: ${result.error ?? "check failed"}${result.statusCode ? ` (HTTP ${result.statusCode})` : ""}\nDetected: ${now.toISOString()}\nPlease take necessary action.`,
    );
    logger.warn({ monitorId: String(monitor._id), incidentId: String(incident._id) }, "Incident opened");
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err; // ignore duplicate open incident
  }
}

async function handleRecovery(monitor: MonitorWithId, result: CheckResult, now: Date): Promise<void> {
  const wasDown = !!monitor.currentIncidentId;

  await Monitor.updateOne(
    { _id: monitor._id },
    {
      consecutiveFailures: 0,
      status: "operational",
      currentIncidentId: null,
      lastCheckedAt: now,
      lastResponseTimeMs: result.responseTimeMs,
    },
  );
  if (!wasDown) return;

  const incident = await Incident.findOneAndUpdate(
    { _id: monitor.currentIncidentId, status: "open" },
    [
      {
        $set: {
          status: "resolved",
          resolvedAt: now,
          durationSec: { $round: [{ $divide: [{ $subtract: [now, "$startedAt"] }, 1000] }, 0] },
          notifiedResolved: true,
        },
      },
    ],
    { new: true },
  );
  if (!incident) return;

  await sendEmail(
    incidentResolvedEmail({
      to: await alertRecipients(monitor),
      monitorName: monitor.name,
      url: monitor.url,
      downtime: formatDuration(incident.durationSec ?? 0),
      recoveredAt: now.toISOString(),
    }),
  );
  const recoveryMentions = await memberMentions(monitor);
  await notifyChannels(
    monitor.channels as unknown[] | undefined,
    `${recoveryMentions ? recoveryMentions + "\n" : ""}🟢 *RECOVERED* — ${monitor.name}\n${monitor.url}\nDowntime: ${formatDuration(incident.durationSec ?? 0)}`,
  );
  logger.info({ monitorId: String(monitor._id), incidentId: String(incident._id) }, "Incident resolved");
}

async function handleSslWarnings(monitor: MonitorWithId, expiresAt: Date, now: Date): Promise<void> {
  const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  const warned = new Set(monitor.sslWarnedThresholds ?? []);
  const due = [...SSL_WARN_DAYS].sort((a, b) => b - a).find((t) => daysRemaining <= t && !warned.has(t));

  await Monitor.updateOne({ _id: monitor._id }, { sslExpiresAt: expiresAt });
  if (due === undefined || daysRemaining < 0) return;

  await Monitor.updateOne({ _id: monitor._id }, { $addToSet: { sslWarnedThresholds: due } });
  await sendEmail(
    sslWarningEmail({
      to: await alertRecipients(monitor),
      domain: monitor.url,
      expiresAt: expiresAt.toISOString(),
      daysRemaining,
    }),
  );
  await notifyChannels(
    monitor.channels as unknown[] | undefined,
    `⚠️ *SSL expiring* — ${monitor.url}\nCertificate expires in ${daysRemaining} day(s) (${expiresAt.toDateString()}).`,
  );
  logger.warn({ monitorId: String(monitor._id), daysRemaining, threshold: due }, "SSL warning sent");
}
