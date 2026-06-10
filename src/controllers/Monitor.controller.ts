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
import { sendEmail, testNotificationEmail } from "../services/mailer";
import {
  assertCanReadMonitor,
  assertCanWriteMonitor,
  monitorScopeFilter,
} from "../utils/access";
import type { UptimeRange } from "../utils/constants";

const RANGE_MS: Record<UptimeRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

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

export async function listMonitors(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = { ...monitorScopeFilter(req.user!) };
  if (q.type) filter.type = q.type;
  if (q.enabled !== undefined) filter.enabled = q.enabled === "true";

  const [data, total] = await Promise.all([
    Monitor.find(filter).sort(parseSort(q.sort)).skip(skip(page, limit)).limit(limit).lean(),
    Monitor.countDocuments(filter),
  ]);
  res.json(paginate(data, total, page, limit));
}

export async function getMonitor(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id).populate("members", "name email avatarUrl").lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  assertCanReadMonitor(req.user!, monitor);
  res.json(monitor);
}

export async function updateMonitor(req: Request, res: Response): Promise<void> {
  const existing = await Monitor.findById(req.params.id).lean();
  if (!existing) throw ApiError.notFound("Monitor not found");
  assertCanWriteMonitor(req.user!, existing, "update");

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
  assertCanWriteMonitor(req.user!, existing, "delete");

  await Monitor.findByIdAndDelete(req.params.id);
  await writeAudit(req, "monitor.delete", { targetType: "monitor", targetId: req.params.id });
  res.status(204).send();
}

async function setEnabled(req: Request, res: Response, enabled: boolean, action: string) {
  const existing = await Monitor.findById(req.params.id).lean();
  if (!existing) throw ApiError.notFound("Monitor not found");
  assertCanWriteMonitor(req.user!, existing, "update");

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
  assertCanWriteMonitor(req.user!, existing, "run");

  await Monitor.findByIdAndUpdate(req.params.id, { nextRunAt: new Date() });
  await writeAudit(req, "monitor.run", { targetType: "monitor", targetId: req.params.id });
  res.status(202).json({ message: "Check scheduled — will run on the next cron tick" });
}

/** Send a test notification to the monitor's recipients (members + extra emails). */
export async function testNotification(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id).lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  assertCanWriteMonitor(req.user!, monitor, "run");

  const to = await recipientsFor(monitor);
  if (!to.length) throw ApiError.badRequest("This monitor has no alert recipients configured");

  await sendEmail(testNotificationEmail({ to, monitorName: monitor.name, url: monitor.url }));
  await writeAudit(req, "monitor.test_notification", { targetType: "monitor", targetId: req.params.id });
  res.json({ message: `Test notification sent to ${to.length} recipient(s)`, recipients: to });
}

export async function monitorChecks(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id).lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  assertCanReadMonitor(req.user!, monitor);

  const { page, limit } = pageParams(req.query);
  const filter = { monitorId: req.params.id };
  const [data, total] = await Promise.all([
    Check.find(filter).sort({ checkedAt: -1 }).skip(skip(page, limit)).limit(limit).lean(),
    Check.countDocuments(filter),
  ]);
  res.json(paginate(data, total, page, limit));
}

export async function monitorUptime(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id).select("createdBy members").lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  assertCanReadMonitor(req.user!, monitor);

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
  assertCanReadMonitor(req.user!, monitor);

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
    lastCheckedAt: monitor.lastCheckedAt ?? null,
    intervalSec: monitor.intervalSec,
    sslExpiresAt: monitor.sslExpiresAt ?? null,
    uptime: { "24h": windowPct(RANGE_MS["24h"]), "7d": windowPct(RANGE_MS["7d"]), "30d": windowPct(RANGE_MS["30d"]) },
    response: resp
      ? { avg: Math.round(resp.avg), min: resp.min, max: resp.max, checks: resp.total }
      : { avg: null, min: null, max: null, checks: 0 },
    totalIncidents,
  });
}
