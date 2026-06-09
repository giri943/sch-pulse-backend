import type { Request, Response } from "express";
import { Monitor } from "../models/monitor.model";
import { Incident } from "../models/incident.model";
import { UptimeStat } from "../models/uptimeStat.model";
import { SSL_WARN_DAYS, type UptimeRange } from "../utils/constants";

const RANGE_MS: Record<UptimeRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export async function globalStats(_req: Request, res: Response): Promise<void> {
  const from = new Date(Date.now() - RANGE_MS["30d"]);
  const [totalMonitors, monitorsDown, openIncidents, agg] = await Promise.all([
    Monitor.countDocuments({ enabled: true }),
    Monitor.countDocuments({ status: "down" }),
    Incident.countDocuments({ status: "open" }),
    UptimeStat.aggregate<{ ups: number; count: number }>([
      { $match: { bucketStart: { $gte: from } } },
      { $group: { _id: null, ups: { $sum: "$ups" }, count: { $sum: "$count" } } },
    ]),
  ]);
  const a = agg[0];
  const uptime30d = a && a.count ? Number(((a.ups / a.count) * 100).toFixed(2)) : 100;
  res.json({
    stats: { totalMonitors, monitorsDown, openIncidents, uptime30d },
    generatedAt: new Date().toISOString(),
  });
}

export async function uptimeOverview(req: Request, res: Response): Promise<void> {
  const range = ((req.query.range as string) || "24h") as UptimeRange;
  const from = new Date(Date.now() - (RANGE_MS[range] ?? RANGE_MS["24h"]));
  const rows = await UptimeStat.aggregate([
    { $match: { bucketStart: { $gte: from } } },
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

export async function recentIncidents(_req: Request, res: Response): Promise<void> {
  const data = await Incident.find({})
    .sort({ startedAt: -1 })
    .limit(10)
    .populate("monitorId", "name url")
    .lean();
  res.json(data);
}

export async function sslExpiring(_req: Request, res: Response): Promise<void> {
  const horizon = new Date(Date.now() + SSL_WARN_DAYS[0] * 24 * 60 * 60 * 1000);
  const monitors = await Monitor.find({ sslExpiresAt: { $ne: null, $lte: horizon } })
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

export async function statusBoard(_req: Request, res: Response): Promise<void> {
  const monitors = await Monitor.find({})
    .select("name url status lastResponseTimeMs")
    .sort({ status: 1, name: 1 })
    .lean();
  res.json(
    monitors.map((m) => ({
      monitorId: String(m._id),
      name: m.name,
      url: m.url,
      status: m.status,
      lastResponseTimeMs: m.lastResponseTimeMs ?? null,
    })),
  );
}
