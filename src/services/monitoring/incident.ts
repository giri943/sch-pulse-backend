import { Check } from "../../models/check.model";
import { Incident } from "../../models/incident.model";
import { Monitor } from "../../models/monitor.model";
import { User } from "../../models/user.model";
import { ProjectMember } from "../../models/projectMember.model";
import { EscalationPolicy } from "../../models/escalationPolicy.model";
import { FAILURE_THRESHOLD, SSL_WARN_DAYS } from "../../utils/constants";
import { logger } from "../../config/logger";
import type { CheckResult, MonitorWithId } from "./types";
import { recordStat } from "./stats";
import { getRecommendations } from "../recommendations";
import { notifyChannels, pulseChat, chatMonitorLink } from "../channels";
import { projectNameOf } from "../../utils/projectName";
import { monitorChatMentions } from "../../utils/mentions";
import { humanizeError } from "../../utils/humanizeError";
import { isUnderMaintenance } from "./maintenance";
import {
  formatDuration,
  incidentOpenedEmail,
  incidentResolvedEmail,
  monitorDegradedEmail,
  monitorRecoveredEmail,
  sendEmail,
  sslWarningEmail,
} from "../mailer";

/** Recheck a degraded monitor sooner than its interval so we escalate/clear fast. */
const DEGRADED_RECHECK_MS = 2 * 60 * 1000;

/** A project's owners — always alerted (email) + @mentioned (Gchat) for its monitors. */
async function projectOwnerTargets(projectId: unknown): Promise<{ emails: string[]; mentions: string[] }> {
  if (!projectId) return { emails: [], mentions: [] };
  const owners = await ProjectMember.find({ projectId, role: "owner" }).select("userId").lean();
  if (!owners.length) return { emails: [], mentions: [] };
  const users = await User.find({ _id: { $in: owners.map((o) => o.userId) } }).select("email googleId").lean();
  return {
    emails: users.map((u) => u.email).filter(Boolean),
    mentions: users.filter((u) => u.googleId).map((u) => `<users/${u.googleId}>`),
  };
}

/** Alert recipients = project owners + tagged members' emails + extra free-text emails. */
async function alertRecipients(monitor: MonitorWithId): Promise<string[]> {
  const memberIds = (monitor.members as unknown[] | undefined) ?? [];
  let memberEmails: string[] = [];
  if (memberIds.length) {
    const users = await User.find({ _id: { $in: memberIds } }).select("email").lean();
    memberEmails = users.map((u) => u.email);
  }
  const extras = (monitor.extraAlertEmails as string[] | undefined) ?? [];
  const owners = await projectOwnerTargets(monitor.projectId);
  return [...new Set([...owners.emails, ...memberEmails, ...extras])];
}

/** Google Chat @mentions for the monitor's owner(s) + tagged members. */
async function memberMentions(monitor: MonitorWithId): Promise<string> {
  return monitorChatMentions(monitor);
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
    classification: result.classification,
    waf: result.waf ?? null,
  });

  // Planned maintenance: keep the raw check above, but don't count it toward SLA
  // and don't raise incidents/alerts — planned downtime shouldn't false-alarm.
  const underMaintenance = await isUnderMaintenance(monitor._id, monitor.projectId);
  if (!underMaintenance) await recordStat(monitor._id, result, now);

  // SSL expiry is auto-tracked for any monitor whose check captured a certificate.
  if (result.sslExpiresAt) {
    await handleSslWarnings(monitor, result.sslExpiresAt, now);
  }

  if (underMaintenance) {
    await Monitor.updateOne({ _id: monitor._id }, { status: "maintenance", lastCheckedAt: now, ...wafPatch(result, now) });
    return;
  }

  if (result.up) await handleRecovery(monitor, result, now);
  else await handleFailure(monitor, result, now);
}

/** Per-check WAF/classification state to persist on the monitor (whatever the up/down verdict). */
function wafPatch(result: CheckResult, now: Date): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    lastClassification: result.classification ?? null,
    waf: result.waf ?? null,
  };
  if (result.waf) patch.wafDetectedAt = now;
  return patch;
}

/** Alert that a monitor just degraded (one failed check; rechecking shortly). */
async function sendDegradedAlert(monitor: MonitorWithId, result: CheckResult, now: Date): Promise<void> {
  const monitorId = String(monitor._id);
  // Resolve the three independent reads together, then fire email + chat in
  // parallel (allSettled so one slow/failing transport can't block the other).
  const [project, to, mentions] = await Promise.all([
    projectNameOf(monitor.projectId),
    alertRecipients(monitor),
    memberMentions(monitor),
  ]);
  await Promise.allSettled([
    sendEmail(
      monitorDegradedEmail({
        to,
        monitorName: monitor.name,
        url: monitor.url,
        error: result.error ?? "Check failed",
        statusCode: result.statusCode,
        server: result.server,
        timestamp: now.toISOString(),
        monitorId,
        project,
      }),
    ),
    notifyChannels(
      monitor.channels as unknown[] | undefined,
      pulseChat({
        status: "warn",
        title: `${monitor.name} is degraded`,
        subtitle: project,
        mentions,
        rows: [
          ["URL", monitor.url],
          ["What this means", humanizeError({ statusCode: result.statusCode, error: result.error, server: result.server })],
          ["Error", result.error ?? "Check failed"],
          ["Response code", result.statusCode != null ? String(result.statusCode) : undefined],
          ["Detected", now.toLocaleString("en-GB")],
        ],
        button: { text: "View monitor", url: chatMonitorLink(monitorId) },
      }),
    ),
  ]);
  logger.warn({ monitorId }, "Degraded alert sent");
}

/** Alert that a degraded monitor recovered without ever going down. */
async function sendDegradedRecoveredAlert(monitor: MonitorWithId, result: CheckResult, now: Date): Promise<void> {
  const monitorId = String(monitor._id);
  const [project, to, mentions] = await Promise.all([
    projectNameOf(monitor.projectId),
    alertRecipients(monitor),
    memberMentions(monitor),
  ]);
  void result; // signature parity with the other alert helpers
  await Promise.allSettled([
    sendEmail(
      monitorRecoveredEmail({
        to,
        monitorName: monitor.name,
        url: monitor.url,
        recoveredAt: now.toISOString(),
        monitorId,
        project,
      }),
    ),
    notifyChannels(
      monitor.channels as unknown[] | undefined,
      pulseChat({
        status: "up",
        title: `${monitor.name} recovered`,
        subtitle: project,
        mentions,
        rows: [
          ["URL", monitor.url],
          ["Status", "Back to normal after a degraded check"],
        ],
        button: { text: "View monitor", url: chatMonitorLink(monitorId) },
      }),
    ),
  ]);
  logger.info({ monitorId }, "Degraded-recovery alert sent");
}

async function handleFailure(monitor: MonitorWithId, result: CheckResult, now: Date): Promise<void> {
  const failures = (monitor.consecutiveFailures ?? 0) + 1;
  const isDown = failures >= FAILURE_THRESHOLD;
  const willOpen = isDown && !monitor.currentIncidentId;

  const update: Record<string, unknown> = {
    consecutiveFailures: failures,
    status: isDown ? "down" : "degraded",
    lastCheckedAt: now,
    lastResponseTimeMs: result.responseTimeMs,
    ...wafPatch(result, now),
  };
  // Item 6: while degraded, recheck in 2 min (overriding the interval) so we
  // escalate to "down" — or clear — fast.
  if (!isDown) update.nextRunAt = new Date(now.getTime() + DEGRADED_RECHECK_MS);
  await Monitor.updateOne({ _id: monitor._id }, update);

  // Still degraded (not yet down): alert once, on the transition into degraded.
  if (!isDown) {
    if (failures === 1) await sendDegradedAlert(monitor, result, now);
    return;
  }
  if (!willOpen) return; // already down — incident already open, don't re-alert

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
      trigger: { statusCode: result.statusCode, error: result.error, responseTimeMs: result.responseTimeMs, server: result.server },
      recommendations,
      notifiedDown: true,
    });
    await Monitor.updateOne({ _id: monitor._id }, { currentIncidentId: incident._id });

    const monitorId = String(monitor._id);
    const [project, to, mentions] = await Promise.all([
      projectNameOf(monitor.projectId),
      alertRecipients(monitor),
      memberMentions(monitor),
    ]);
    await Promise.allSettled([
      sendEmail(
        incidentOpenedEmail({
          to,
          monitorName: monitor.name,
          url: monitor.url,
          error: result.error ?? "Check failed",
          statusCode: result.statusCode,
          server: result.server,
          timestamp: now.toISOString(),
          recommendations,
          monitorId,
          project,
        }),
      ),
      notifyChannels(
        monitor.channels as unknown[] | undefined,
        pulseChat({
          status: "down",
          title: `${monitor.name} is down`,
          subtitle: project,
          mentions,
          rows: [
            ["URL", monitor.url],
            ["What this means", humanizeError({ statusCode: result.statusCode, error: result.error, server: result.server })],
            ["Error", result.error ?? "Check failed"],
            ["Response code", result.statusCode != null ? String(result.statusCode) : undefined],
            ["Detected", now.toLocaleString("en-GB")],
          ],
          button: { text: "View incident", url: chatMonitorLink(monitorId) },
        }),
      ),
    ]);
    logger.warn({ monitorId: String(monitor._id), incidentId: String(incident._id) }, "Incident opened");
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err; // ignore duplicate open incident
  }
}

async function handleRecovery(monitor: MonitorWithId, result: CheckResult, now: Date): Promise<void> {
  const wasDown = !!monitor.currentIncidentId;
  const wasDegraded = !wasDown && (monitor.consecutiveFailures ?? 0) > 0;

  await Monitor.updateOne(
    { _id: monitor._id },
    {
      consecutiveFailures: 0,
      status: "operational",
      currentIncidentId: null,
      lastCheckedAt: now,
      lastResponseTimeMs: result.responseTimeMs,
      ...wafPatch(result, now),
    },
  );
  // Recovered from a degraded blip without ever going down → one "recovered" alert.
  if (!wasDown) {
    if (wasDegraded) await sendDegradedRecoveredAlert(monitor, result, now);
    return;
  }

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

  const monitorId = String(monitor._id);
  const downtime = formatDuration(incident.durationSec ?? 0);
  // If this incident had been escalated to leadership, loop them in on the
  // resolution too (close the loop). Non-escalated incidents don't notify them.
  const wasEscalated = (incident.escalationsSent?.length ?? 0) > 0;
  const [project, baseRecipients, mentions, leadershipEmails] = await Promise.all([
    projectNameOf(monitor.projectId),
    alertRecipients(monitor),
    memberMentions(monitor),
    wasEscalated
      ? EscalationPolicy.findOne({ key: "global" }).lean().then((p) => p?.emails ?? [])
      : Promise.resolve([] as string[]),
  ]);
  const to = [...new Set([...baseRecipients, ...leadershipEmails])];
  await Promise.allSettled([
    sendEmail(
      incidentResolvedEmail({
        to,
        monitorName: monitor.name,
        url: monitor.url,
        downtime,
        recoveredAt: now.toISOString(),
        monitorId,
        project,
      }),
    ),
    notifyChannels(
      monitor.channels as unknown[] | undefined,
      pulseChat({
        status: "up",
        title: `${monitor.name} recovered`,
        subtitle: project,
        mentions,
        rows: [
          ["URL", monitor.url],
          ["Total downtime", downtime],
          ["Recovered", now.toLocaleString("en-GB")],
        ],
        button: { text: "View monitor", url: chatMonitorLink(monitorId) },
      }),
    ),
  ]);
  logger.info({ monitorId: String(monitor._id), incidentId: String(incident._id) }, "Incident resolved");
}

export async function handleSslWarnings(monitor: MonitorWithId, expiresAt: Date, now: Date): Promise<void> {
  const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  const warned = new Set(monitor.sslWarnedThresholds ?? []);
  const due = [...SSL_WARN_DAYS].sort((a, b) => b - a).find((t) => daysRemaining <= t && !warned.has(t));

  await Monitor.updateOne({ _id: monitor._id }, { sslExpiresAt: expiresAt });
  if (due === undefined || daysRemaining < 0) return;

  await Monitor.updateOne({ _id: monitor._id }, { $addToSet: { sslWarnedThresholds: due } });
  const project = await projectNameOf(monitor.projectId);
  const monitorId = String(monitor._id);
  await sendEmail(
    sslWarningEmail({
      to: await alertRecipients(monitor),
      domain: monitor.url,
      expiresAt: expiresAt.toISOString(),
      daysRemaining,
      monitorId,
      monitorName: monitor.name,
      project,
    }),
  );
  await notifyChannels(
    monitor.channels as unknown[] | undefined,
    pulseChat({
      status: "warn",
      title: `SSL expiring in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`,
      subtitle: monitor.name,
      rows: [
        ["Monitor", monitor.name],
        ["URL", monitor.url],
        ["Expires", expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })],
      ],
      button: { text: "View monitor", url: chatMonitorLink(monitorId) },
    }),
  );
  logger.warn({ monitorId: String(monitor._id), daysRemaining, threshold: due }, "SSL warning sent");
}
