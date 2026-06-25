import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Monitor } from "../models/monitor.model";
import { Check } from "../models/check.model";
import { Incident } from "../models/incident.model";
import { UptimeStat } from "../models/uptimeStat.model";
import { User } from "../models/user.model";
import { ApiError } from "../utils/ApiError";
import { paginate, pageParams } from "../utils/response";
import { parseSort, skip } from "../utils/query";
import { writeAudit } from "../utils/audit";
import { sendEmail, testNotificationEmail, monitorJoinedEmail } from "../services/mailer";
import { notifyChannels, pulseChat, chatMonitorLink } from "../services/channels";
import {
  assertCanCreateInProject,
  assertCanReadMonitor,
  assertCanWriteMonitor,
  isOwnerOrMember,
  monitorScopeFilter,
} from "../utils/access";
import { normalizeUrl } from "../utils/url";
import { sparklines } from "../utils/sparkline";
import { monitorChatMentions } from "../utils/mentions";
import type { UptimeRange } from "../utils/constants";

const RANGE_MS: Record<UptimeRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Normalize populated members/channels to clean { id, ... } refs, dropping deleted (null) refs. */
function serializeMonitor<T extends Record<string, unknown>>(m: T): T {
  const ref = (r: unknown): { _id?: unknown; id?: unknown; name?: string; email?: string; avatarUrl?: string | null; type?: string } | null =>
    r && typeof r === "object" ? (r as Record<string, unknown>) : null;
  const members = (m.members as unknown[] | undefined) ?? [];
  const channels = (m.channels as unknown[] | undefined) ?? [];
  const projRef = ref(m.projectId);
  return {
    ...m,
    projectId: projRef?._id ? String(projRef._id) : m.projectId ? String(m.projectId) : null,
    project: projRef?._id ? { id: String(projRef._id), name: projRef.name } : null,
    members: members
      .map(ref)
      .filter((u): u is NonNullable<typeof u> => !!u && !!u._id)
      .map((u) => ({ id: String(u._id), name: u.name, email: u.email, avatarUrl: u.avatarUrl ?? null })),
    channels: channels
      .map(ref)
      .filter((c): c is NonNullable<typeof c> => !!c && !!c._id)
      .map((c) => ({ id: String(c._id), name: c.name, type: c.type })),
  };
}

/** Resolve a monitor's alert recipients = tagged members' emails + extra emails. */
async function recipientsFor(monitor: { members?: unknown[]; extraAlertEmails?: string[] }): Promise<string[]> {
  const memberIds = monitor.members ?? [];
  let memberEmails: string[] = [];
  if (memberIds.length) {
    const users = await User.find({ _id: { $in: memberIds } }).select("email").lean();
    memberEmails = users.map((u) => u.email);
  }
  return [...new Set([...memberEmails, ...(monitor.extraAlertEmails ?? [])])];
}

export async function createMonitor(req: Request, res: Response): Promise<void> {
  // You can only add a monitor to a project you own/edit (General is open).
  await assertCanCreateInProject(req.user!, req.body.projectId);

  // Duplicate monitors are not allowed — one monitor per target (normalized
  // URL), org-wide. If a monitor already exists, the user must join it instead.
  const dup = await findDuplicateMonitor(String(req.body.url ?? ""));
  if (dup) {
    const alreadyMember = isOwnerOrMember(req.user!, dup);
    throw new ApiError(409, "A monitor already exists for this URL.", "DUPLICATE_MONITOR", {
      existing: { id: String(dup._id), name: dup.name, url: dup.url, alreadyMember },
    });
  }

  const monitor = await Monitor.create({
    ...req.body,
    createdBy: req.user!.id,
    nextRunAt: new Date(),
    status: "unknown",
  });
  await writeAudit(req, "monitor.create", {
    targetType: "monitor",
    targetId: String(monitor._id),
    metadata: { name: monitor.name, url: monitor.url },
  });
  res.status(201).json(monitor);
}

/**
 * Find an existing, non-archived monitor whose URL normalizes to the same key.
 * Narrows candidates by host (cheap), then compares normalized keys exactly.
 */
async function findDuplicateMonitor(url: string) {
  const key = normalizeUrl(url);
  let host = "";
  try {
    host = new URL(url.trim()).hostname;
  } catch {
    host = url.trim();
  }
  if (!host) return null;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = await Monitor.find({
    softDeletedAt: null,
    url: new RegExp(escaped, "i"),
  })
    .select("name url members createdBy")
    .lean();
  return candidates.find((m) => normalizeUrl(m.url) === key) ?? null;
}

/**
 * Search monitors org-wide so a user can discover and join one they're not on
 * yet. Returns minimal, non-sensitive fields only. Matches name or URL.
 */
export async function discoverMonitors(req: Request, res: Response): Promise<void> {
  const q = String((req.query.q as string) ?? "").trim();
  const filter: Record<string, unknown> = { softDeletedAt: null };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { url: rx }];
  }
  const monitors = await Monitor.find(filter)
    .select("name url type status members createdBy")
    .sort({ name: 1 })
    .limit(25)
    .lean();
  const data = monitors.map((m) => ({
    id: String(m._id),
    name: m.name,
    url: m.url,
    type: m.type,
    status: m.status,
    memberCount: (m.members as unknown[] | undefined)?.length ?? 0,
    alreadyMember: isOwnerOrMember(req.user!, m),
  }));
  res.json({ data });
}

/** Join an existing monitor: add the current user to its members (visibility + alerts). */
export async function joinMonitor(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id);
  if (!monitor || monitor.softDeletedAt) throw ApiError.notFound("Monitor not found");

  const uid = req.user!.id;
  let joined = false;
  if (!isOwnerOrMember(req.user!, monitor)) {
    monitor.members.push(new Types.ObjectId(uid));
    await monitor.save();
    joined = true;
    await writeAudit(req, "monitor.join", {
      targetType: "monitor",
      targetId: String(monitor._id),
      metadata: { name: monitor.name, url: monitor.url },
    });
  }

  if (joined) {
    // Notify just the owner and the joiner (not the whole team).
    const people = await User.find({ _id: { $in: [monitor.createdBy, new Types.ObjectId(uid)] } })
      .select("email name googleId")
      .lean();
    const to = [...new Set(people.map((p) => p.email).filter(Boolean))];
    const mentions = people
      .filter((p) => p.googleId)
      .map((p) => `<users/${p.googleId}>`)
      .join(" ");
    const joinerName = req.user!.name || req.user!.email;
    const joinedMonitorId = String(monitor._id);
    void sendEmail(monitorJoinedEmail({ to, monitorName: monitor.name, url: monitor.url, joinerName, monitorId: joinedMonitorId }));
    void notifyChannels(
      monitor.channels as unknown[] | undefined,
      pulseChat({
        status: "info",
        title: `${joinerName} joined ${monitor.name}`,
        mentions,
        rows: [
          ["Monitor", monitor.name],
          ["URL", monitor.url],
        ],
        button: { text: "View monitor", url: chatMonitorLink(joinedMonitorId) },
      }),
    );
  }

  const populated = await Monitor.findById(monitor._id)
    .populate("projectId", "name")
    .populate("members", "name email avatarUrl")
    .populate("channels", "name type")
    .lean();
  res.json(serializeMonitor(populated!));
}

export async function listMonitors(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = { ...(await monitorScopeFilter(req.user!)) };
  if (q.type) filter.type = q.type;
  if (q.projectId) filter.projectId = q.projectId;
  if (q.enabled !== undefined) filter.enabled = q.enabled === "true";
  // Archived (soft-deleted) monitors are hidden unless explicitly requested.
  filter.softDeletedAt = q.deleted === "true" ? { $ne: null } : null;

  const [data, total] = await Promise.all([
    Monitor.find(filter)
      .sort(parseSort(q.sort))
      .skip(skip(page, limit))
      .limit(limit)
      .populate("projectId", "name")
    .populate("members", "name email avatarUrl")
      .populate("channels", "name type")
      .lean(),
    Monitor.countDocuments(filter),
  ]);

  // Attach a 24h sparkline (hourly avg response time) + 24h uptime to each card,
  // in ONE aggregation across the whole page — no per-card round-trips.
  const sparks = await sparklines(data.map((m) => m._id as Types.ObjectId));
  const enriched = data.map((m) => {
    const s = sparks.get(String(m._id));
    return { ...serializeMonitor(m), spark: s?.spark ?? [], uptime24h: s?.uptime24h ?? null };
  });
  res.json(paginate(enriched, total, page, limit));
}

export async function getMonitor(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id)
    .populate("projectId", "name")
    .populate("members", "name email avatarUrl")
    .populate("channels", "name type")
    .lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  await assertCanReadMonitor(req.user!, monitor);
  res.json(serializeMonitor(monitor));
}

export async function updateMonitor(req: Request, res: Response): Promise<void> {
  const existing = await Monitor.findById(req.params.id).lean();
  if (!existing) throw ApiError.notFound("Monitor not found");
  await assertCanWriteMonitor(req.user!, existing, "update");

  const monitor = await Monitor.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
  await writeAudit(req, "monitor.update", {
    targetType: "monitor",
    targetId: req.params.id,
    metadata: { changes: req.body },
  });
  res.json(monitor);
}

export async function deleteMonitor(req: Request, res: Response): Promise<void> {
  const existing = await Monitor.findById(req.params.id).lean();
  if (!existing) throw ApiError.notFound("Monitor not found");
  await assertCanWriteMonitor(req.user!, existing, "delete");

  // Cascade: remove the monitor's checks, incidents and stats too.
  await Promise.all([
    Check.deleteMany({ monitorId: existing._id }),
    Incident.deleteMany({ monitorId: existing._id }),
    UptimeStat.deleteMany({ monitorId: existing._id }),
  ]);
  await Monitor.findByIdAndDelete(req.params.id);
  await writeAudit(req, "monitor.delete", { targetType: "monitor", targetId: req.params.id });
  res.status(204).send();
}

/** Restore a soft-deleted (expired) monitor; clears the expiry so it won't re-expire. */
export async function restoreMonitor(req: Request, res: Response): Promise<void> {
  const existing = await Monitor.findById(req.params.id).lean();
  if (!existing) throw ApiError.notFound("Monitor not found");
  await assertCanWriteMonitor(req.user!, existing, "update");

  const monitor = await Monitor.findByIdAndUpdate(
    req.params.id,
    { softDeletedAt: null, enabled: true, status: "unknown", nextRunAt: new Date(), expiresAt: null, expiryRemindersSent: [] },
    { new: true },
  ).lean();
  await writeAudit(req, "monitor.restore", { targetType: "monitor", targetId: req.params.id });
  res.json(monitor);
}

async function setEnabled(req: Request, res: Response, enabled: boolean, action: string) {
  const existing = await Monitor.findById(req.params.id).lean();
  if (!existing) throw ApiError.notFound("Monitor not found");
  await assertCanWriteMonitor(req.user!, existing, "update");

  const update = enabled
    ? { enabled: true, status: "unknown", nextRunAt: new Date() }
    : { enabled: false, status: "paused" };
  const monitor = await Monitor.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
  await writeAudit(req, action, { targetType: "monitor", targetId: req.params.id });
  res.json(monitor);
}

export const pauseMonitor = (req: Request, res: Response) => setEnabled(req, res, false, "monitor.pause");
export const resumeMonitor = (req: Request, res: Response) => setEnabled(req, res, true, "monitor.resume");

/** Trigger an immediate check: mark the monitor due so the cron runs it next tick. */
export async function runMonitor(req: Request, res: Response): Promise<void> {
  const existing = await Monitor.findById(req.params.id).lean();
  if (!existing) throw ApiError.notFound("Monitor not found");
  await assertCanWriteMonitor(req.user!, existing, "run");

  await Monitor.findByIdAndUpdate(req.params.id, { nextRunAt: new Date() });
  await writeAudit(req, "monitor.run", { targetType: "monitor", targetId: req.params.id });
  res.status(202).json({ message: "Check scheduled — will run on the next cron tick" });
}

/** Send a test notification to the monitor's recipients (members + extra emails). */
export async function testNotification(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id).lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  await assertCanWriteMonitor(req.user!, monitor, "run");

  const to = await recipientsFor(monitor);
  const channelIds = (monitor.channels as unknown[] | undefined) ?? [];
  if (!to.length && !channelIds.length)
    throw ApiError.badRequest("This monitor has no alert recipients or notification channels configured");

  // Send chat and email independently so one failing transport (e.g. SMTP
  // blocked on the host) doesn't prevent the other or hang the request.
  const testMonitorId = String(monitor._id);
  const mentions = await monitorChatMentions(monitor);
  const [emailResult, channelCount] = await Promise.all([
    to.length
      ? sendEmail(testNotificationEmail({ to, monitorName: monitor.name, url: monitor.url, monitorId: testMonitorId }))
      : Promise.resolve({ ok: false as const }),
    channelIds.length
      ? notifyChannels(
          channelIds as Parameters<typeof notifyChannels>[0],
          pulseChat({
            status: "info",
            title: `Test alert — ${monitor.name}`,
            mentions,
            rows: [
              ["Monitor", monitor.name],
              ["URL", monitor.url],
              ["Status", "Alerts are configured correctly ✅"],
            ],
            button: { text: "View monitor", url: chatMonitorLink(testMonitorId) },
          }),
        )
      : Promise.resolve(0),
  ]);

  await writeAudit(req, "monitor.test_notification", { targetType: "monitor", targetId: req.params.id });

  const emailOk = emailResult.ok;
  const sent: string[] = [];
  if (emailOk) sent.push(`${to.length} email recipient(s)`);
  if (channelCount) sent.push(`${channelCount} chat channel(s)`);
  const emailFailed = to.length > 0 && !emailOk;
  const reason = "error" in emailResult && emailResult.error ? ` (${emailResult.error})` : "";
  const message = sent.length
    ? `Test notification sent to ${sent.join(" and ")}` +
      (emailFailed ? `. Email could not be sent${reason}.` : "")
    : `Test notification could not be delivered — email failed${reason} and no chat channels are configured.`;

  res.json({
    message,
    emailSent: emailOk,
    emailError: "error" in emailResult ? emailResult.error : undefined,
    recipients: to,
    channels: channelCount,
    emailFailed,
  });
}

export async function monitorChecks(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id).lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  await assertCanReadMonitor(req.user!, monitor);

  const { page, limit } = pageParams(req.query);
  const filter = { monitorId: req.params.id };
  const [data, total] = await Promise.all([
    Check.find(filter).sort({ checkedAt: -1 }).skip(skip(page, limit)).limit(limit).lean(),
    Check.countDocuments(filter),
  ]);
  res.json(paginate(data, total, page, limit));
}

export async function monitorUptime(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id).select("createdBy members projectId").lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  await assertCanReadMonitor(req.user!, monitor);

  const range = ((req.query.range as string) || "24h") as UptimeRange;
  const from = new Date(Date.now() - (RANGE_MS[range] ?? RANGE_MS["24h"]));
  const buckets = await UptimeStat.find({
    monitorId: new Types.ObjectId(req.params.id),
    bucketStart: { $gte: from },
  })
    .sort({ bucketStart: 1 })
    .lean();

  const series = buckets.map((b) => ({
    t: b.bucketStart,
    uptime: b.count ? Number(((b.ups / b.count) * 100).toFixed(2)) : null,
    avgResponseMs: b.count ? Math.round(b.sumResponseMs / b.count) : null,
  }));
  const totals = buckets.reduce(
    (acc, b) => ({ ups: acc.ups + b.ups, count: acc.count + b.count }),
    { ups: 0, count: 0 },
  );
  res.json({
    range,
    uptimePct: totals.count ? Number(((totals.ups / totals.count) * 100).toFixed(2)) : null,
    series,
  });
}

/**
 * Headline stats for the monitor detail page: uptime % across 24h/7d/30d, response
 * min/avg/max (24h), incident count, and current-state info.
 */
export async function monitorSummary(req: Request, res: Response): Promise<void> {
  const id = new Types.ObjectId(req.params.id);
  const now = Date.now();

  const monitor = await Monitor.findById(id).lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  await assertCanReadMonitor(req.user!, monitor);

  const down = !!monitor.currentIncidentId;
  let stateSince: Date | null;
  if (down) {
    const open = await Incident.findOne({ monitorId: id, status: "open" }).sort({ startedAt: -1 }).lean();
    stateSince = open?.startedAt ?? null;
  } else {
    const lastResolved = await Incident.findOne({ monitorId: id, status: "resolved" })
      .sort({ resolvedAt: -1 })
      .lean();
    stateSince = lastResolved?.resolvedAt ?? (monitor as { createdAt?: Date }).createdAt ?? null;
  }

  const buckets = await UptimeStat.find({
    monitorId: id,
    bucketStart: { $gte: new Date(now - RANGE_MS["30d"]) },
  }).lean();

  const windowPct = (ms: number): number | null => {
    const from = now - ms;
    let ups = 0;
    let count = 0;
    for (const b of buckets) {
      if (new Date(b.bucketStart).getTime() >= from) {
        ups += b.ups;
        count += b.count;
      }
    }
    return count ? Number(((ups / count) * 100).toFixed(3)) : null;
  };

  const [resp] = await Check.aggregate<{ avg: number; min: number; max: number; total: number }>([
    { $match: { monitorId: id, checkedAt: { $gte: new Date(now - RANGE_MS["24h"]) }, responseTimeMs: { $ne: null } } },
    {
      $group: {
        _id: null,
        avg: { $avg: "$responseTimeMs" },
        min: { $min: "$responseTimeMs" },
        max: { $max: "$responseTimeMs" },
        total: { $sum: 1 },
      },
    },
  ]);

  const totalIncidents = await Incident.countDocuments({ monitorId: id });

  res.json({
    status: monitor.status,
    down,
    stateSince,
    // When monitoring actually began — so the UI never implies more coverage than we have.
    monitoringSince: (monitor as { createdAt?: Date }).createdAt ?? null,
    lastCheckedAt: monitor.lastCheckedAt ?? null,
    intervalSec: monitor.intervalSec,
    sslExpiresAt: monitor.sslExpiresAt ?? null,
    domainExpiresAt: (monitor as { domainExpiresAt?: Date }).domainExpiresAt ?? null,
    uptime: { "24h": windowPct(RANGE_MS["24h"]), "7d": windowPct(RANGE_MS["7d"]), "30d": windowPct(RANGE_MS["30d"]) },
    response: resp
      ? { avg: Math.round(resp.avg), min: resp.min, max: resp.max, checks: resp.total }
      : { avg: null, min: null, max: null, checks: 0 },
    totalIncidents,
  });
}
