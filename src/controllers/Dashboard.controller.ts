import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Monitor } from "../models/monitor.model";
import { Incident } from "../models/incident.model";
import { UptimeStat } from "../models/uptimeStat.model";
import { SSL_WARN_DAYS, type UptimeRange } from "../utils/constants";
import { accessibleMonitorIds } from "../utils/access";
import { sparklines } from "../utils/sparkline";

const RANGE_MS: Record<UptimeRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Build { _id/monitorId in ids } clauses, or {} when the user has full access. */
async function scope(req: Request) {
  const ids = await accessibleMonitorIds(req.user!);
  return {
    monitorFilter: ids === null ? {} : { _id: { $in: ids } },
    byMonitorId: ids === null ? {} : { monitorId: { $in: ids } },
  };
}

export async function globalStats(req: Request, res: Response): Promise<void> {
  const { monitorFilter, byMonitorId } = await scope(req);
  const from = new Date(Date.now() - RANGE_MS["30d"]);
  const [totalMonitors, monitorsDown, openIncidents, agg] = await Promise.all([
    Monitor.countDocuments({ ...monitorFilter, enabled: true }),
    Monitor.countDocuments({ ...monitorFilter, status: "down" }),
    Incident.countDocuments({ ...byMonitorId, status: "open" }),
    UptimeStat.aggregate<{ ups: number; count: number }>([
      { $match: { ...byMonitorId, bucketStart: { $gte: from } } },
      { $group: { _id: null, ups: { $sum: "$ups" }, count: { $sum: "$count" } } },
    ]),
  ]);
  const a = agg[0];
  // null (not 100) when there's no data yet — never report a fake 100%.
  const uptime30d = a && a.count ? Number(((a.ups / a.count) * 100).toFixed(2)) : null;
  res.json({
    stats: { totalMonitors, monitorsDown, openIncidents, uptime30d },
    generatedAt: new Date().toISOString(),
  });
}

export async function uptimeOverview(req: Request, res: Response): Promise<void> {
  const { byMonitorId } = await scope(req);
  const range = ((req.query.range as string) || "24h") as UptimeRange;
  const from = new Date(Date.now() - (RANGE_MS[range] ?? RANGE_MS["24h"]));
  const rows = await UptimeStat.aggregate([
    { $match: { ...byMonitorId, bucketStart: { $gte: from } } },
    {
      $group: {
        _id: "$bucketStart",
        ups: { $sum: "$ups" },
        count: { $sum: "$count" },
        sumResponseMs: { $sum: "$sumResponseMs" },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  res.json({
    range,
    series: rows.map((r) => ({
      t: r._id,
      uptime: r.count ? Number(((r.ups / r.count) * 100).toFixed(2)) : null,
      avgResponseMs: r.count ? Math.round(r.sumResponseMs / r.count) : null,
    })),
  });
}

export async function recentIncidents(req: Request, res: Response): Promise<void> {
  const { byMonitorId } = await scope(req);
  const data = await Incident.find(byMonitorId)
    .sort({ startedAt: -1 })
    .limit(10)
    .populate("monitorId", "name url")
    .lean();
  res.json(data);
}

export async function sslExpiring(req: Request, res: Response): Promise<void> {
  const { monitorFilter } = await scope(req);
  const horizon = new Date(Date.now() + SSL_WARN_DAYS[0] * 24 * 60 * 60 * 1000);
  const monitors = await Monitor.find({ ...monitorFilter, sslExpiresAt: { $ne: null, $lte: horizon } })
    .sort({ sslExpiresAt: 1 })
    .lean();
  res.json(
    monitors.map((m) => ({
      monitorId: String(m._id),
      name: m.name,
      url: m.url,
      sslExpiresAt: m.sslExpiresAt,
      daysRemaining: m.sslExpiresAt
        ? Math.ceil((new Date(m.sslExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
        : null,
    })),
  );
}

export async function statusBoard(req: Request, res: Response): Promise<void> {
  const { monitorFilter } = await scope(req);
  const monitors = await Monitor.find(monitorFilter)
    .select("name url status enabled lastResponseTimeMs")
    .sort({ status: 1, name: 1 })
    .lean();
  const sparks = await sparklines(monitors.map((m) => m._id as Types.ObjectId));
  res.json(
    monitors.map((m) => ({
      monitorId: String(m._id),
      name: m.name,
      url: m.url,
      status: m.status,
      enabled: m.enabled,
      lastResponseTimeMs: m.lastResponseTimeMs ?? null,
      spark: sparks.get(String(m._id))?.spark ?? [],
    })),
  );
}
