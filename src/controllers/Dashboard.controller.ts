import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Monitor } from "../models/monitor.model";
import { Incident } from "../models/incident.model";
import { UptimeStat } from "../models/uptimeStat.model";
import { SSL_WARN_DAYS, type UptimeRange } from "../utils/constants";
import { ApiError } from "../utils/ApiError";

/** Domains within this window are surfaced on the dashboard — more lead time than SSL,
 *  since registration renewal (and recovery from a lapse) is slower and higher-stakes. */
const DOMAIN_HORIZON_DAYS = 60;
import { accessibleMonitorIds } from "../utils/access";
import { sparklines } from "../utils/sparkline";

const RANGE_MS: Record<UptimeRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Read a populated project's name (or null) from a monitor's projectId field. */
function projectName(p: unknown): string | null {
  return p && typeof p === "object" && "name" in p ? String((p as { name: unknown }).name) : null;
}

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
  const range = ((req.query.range as string) || "24h") as UptimeRange;
  const from = new Date(Date.now() - (RANGE_MS[range] ?? RANGE_MS["24h"]));

  // Scope to the caller's accessible monitors, optionally narrowed to one project.
  const ids = await accessibleMonitorIds(req.user!); // null = full access
  let monitorMatch: Record<string, unknown> = ids === null ? {} : { monitorId: { $in: ids } };
  const projectId = String((req.query.projectId as string) ?? "");
  if (projectId && Types.ObjectId.isValid(projectId)) {
    const projMonitorIds = await Monitor.find({
      projectId,
      softDeletedAt: null,
      ...(ids ? { _id: { $in: ids } } : {}),
    }).distinct("_id");
    monitorMatch = { monitorId: { $in: projMonitorIds } };
  }

  const rows = await UptimeStat.aggregate([
    { $match: { ...monitorMatch, bucketStart: { $gte: from } } },
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
      // Raw counts so the client can compute an accurate range-wide uptime.
      ups: r.ups,
      count: r.count,
    })),
  });
}

/** IST is a fixed UTC+05:30 (no DST), so day boundaries are a constant offset. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" of the IST calendar day containing `ms`. */
function istDayKey(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Calendar-month uptime heatmap: one cell per IST day of `month` (YYYY-MM,
 * default = current IST month), scoped to the caller's monitors and optionally
 * narrowed to one project or one monitor.
 *
 * Built from the hourly UptimeStat rollups (kept indefinitely — only raw checks
 * expire), grouped into IST days. Hourly buckets start on UTC hours (= hh:30
 * IST), so each "day" is effectively 00:30→00:30 IST — fine for a heatmap.
 */
export async function uptimeCalendar(req: Request, res: Response): Promise<void> {
  const nowMs = Date.now();
  const monthParam = String(req.query.month ?? "") || istDayKey(nowMs).slice(0, 7);
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthParam);
  if (!m) throw ApiError.badRequest("month must be YYYY-MM");
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const from = new Date(Date.UTC(year, mon - 1, 1) - IST_OFFSET_MS); // IST midnight on the 1st
  const to = new Date(Date.UTC(year, mon, 1) - IST_OFFSET_MS); // IST midnight on the next 1st
  const daysInMonth = Math.round((to.getTime() - from.getTime()) / DAY_MS);

  // Resolve which monitors count: caller's access ∩ project ∩ monitor.
  const ids = await accessibleMonitorIds(req.user!); // null = full access
  const projectId = String(req.query.projectId ?? "");
  const monitorId = String(req.query.monitorId ?? "");
  let monitorIds: Types.ObjectId[] | null = ids;
  if (monitorId) {
    if (!Types.ObjectId.isValid(monitorId)) throw ApiError.badRequest("Invalid monitorId");
    const allowed = ids === null || ids.some((i) => String(i) === monitorId);
    monitorIds = allowed ? [new Types.ObjectId(monitorId)] : [];
  } else if (projectId) {
    if (!Types.ObjectId.isValid(projectId)) throw ApiError.badRequest("Invalid projectId");
    monitorIds = await Monitor.find({
      projectId,
      softDeletedAt: null,
      ...(ids ? { _id: { $in: ids } } : {}),
    }).distinct("_id");
  }
  const byMonitor = monitorIds === null ? {} : { monitorId: { $in: monitorIds } };

  const [rows, incidents] = await Promise.all([
    UptimeStat.aggregate<{ _id: string; ups: number; count: number }>([
      { $match: { ...byMonitor, bucketStart: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$bucketStart", timezone: "+05:30" } },
          ups: { $sum: "$ups" },
          count: { $sum: "$count" },
        },
      },
    ]),
    // Every incident overlapping the month (still-open ones included).
    Incident.find({
      ...byMonitor,
      startedAt: { $lt: to },
      $or: [{ resolvedAt: null }, { resolvedAt: { $gte: from } }],
    })
      .select("monitorId startedAt resolvedAt")
      .populate("monitorId", "name")
      .lean(),
  ]);

  type Day = {
    date: string;
    ups: number;
    count: number;
    uptime: number | null;
    incidents: number;
    downtimeSec: number;
    monitors: string[];
  };
  const days: Day[] = [];
  const byDate = new Map<string, Day>();
  for (let i = 0; i < daysInMonth; i++) {
    const date = istDayKey(from.getTime() + i * DAY_MS);
    const d: Day = { date, ups: 0, count: 0, uptime: null, incidents: 0, downtimeSec: 0, monitors: [] };
    days.push(d);
    byDate.set(date, d);
  }
  for (const r of rows) {
    const d = byDate.get(r._id);
    if (!d) continue;
    d.ups = r.ups;
    d.count = r.count;
    d.uptime = r.count ? Number(((r.ups / r.count) * 100).toFixed(2)) : null;
  }

  // Spread each incident across the IST days it overlaps: count it on every day
  // it touched, and attribute the clipped downtime to each day.
  const monthEnd = Math.min(to.getTime(), nowMs);
  for (const inc of incidents) {
    const s = Math.max(new Date(inc.startedAt).getTime(), from.getTime());
    const e = Math.min(inc.resolvedAt ? new Date(inc.resolvedAt).getTime() : nowMs, monthEnd);
    if (e < s) continue;
    const name = projectName(inc.monitorId) ?? "Monitor";
    let dayIdx = Math.floor((s - from.getTime()) / DAY_MS);
    while (dayIdx < daysInMonth) {
      const dayStart = from.getTime() + dayIdx * DAY_MS;
      // Stop past the end — and don't spill onto a day the incident only touches at 00:00.
      if (dayStart > e || (dayStart === e && dayStart > s)) break;
      const d = days[dayIdx];
      d.incidents += 1;
      d.downtimeSec += Math.round((Math.min(e, dayStart + DAY_MS) - Math.max(s, dayStart)) / 1000);
      if (!d.monitors.includes(name)) d.monitors.push(name);
      dayIdx++;
    }
  }

  const ups = days.reduce((a, d) => a + d.ups, 0);
  const count = days.reduce((a, d) => a + d.count, 0);
  res.json({
    month: monthParam,
    uptime: count ? Number(((ups / count) * 100).toFixed(2)) : null,
    incidents: incidents.length,
    downtimeSec: days.reduce((a, d) => a + d.downtimeSec, 0),
    days,
  });
}

export async function recentIncidents(req: Request, res: Response): Promise<void> {
  const { byMonitorId } = await scope(req);
  const data = await Incident.find(byMonitorId)
    .sort({ startedAt: -1 })
    .limit(10)
    .populate({ path: "monitorId", select: "name url projectId", populate: { path: "projectId", select: "name" } })
    .lean();
  res.json(data);
}

export async function sslExpiring(req: Request, res: Response): Promise<void> {
  const { monitorFilter } = await scope(req);
  const horizon = new Date(Date.now() + SSL_WARN_DAYS[0] * 24 * 60 * 60 * 1000);
  const monitors = await Monitor.find({ ...monitorFilter, sslExpiresAt: { $ne: null, $lte: horizon } })
    .populate("projectId", "name")
    .sort({ sslExpiresAt: 1 })
    .lean();
  res.json(
    monitors.map((m) => ({
      monitorId: String(m._id),
      name: m.name,
      url: m.url,
      project: projectName(m.projectId),
      sslExpiresAt: m.sslExpiresAt,
      daysRemaining: m.sslExpiresAt
        ? Math.ceil((new Date(m.sslExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
        : null,
    })),
  );
}

export async function domainExpiring(req: Request, res: Response): Promise<void> {
  const { monitorFilter } = await scope(req);
  const horizon = new Date(Date.now() + DOMAIN_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const monitors = await Monitor.find({ ...monitorFilter, domainExpiresAt: { $ne: null, $lte: horizon } })
    .populate("projectId", "name")
    .sort({ domainExpiresAt: 1 })
    .lean();
  res.json(
    monitors.map((m) => ({
      monitorId: String(m._id),
      name: m.name,
      url: m.url,
      project: projectName(m.projectId),
      domainExpiresAt: m.domainExpiresAt,
      daysRemaining: m.domainExpiresAt
        ? Math.ceil((new Date(m.domainExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
        : null,
    })),
  );
}

/** Monitors whose monitoring PERIOD (expiresAt) ends within ~2 weeks. */
export async function expiringMonitors(req: Request, res: Response): Promise<void> {
  const { monitorFilter } = await scope(req);
  const horizon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const monitors = await Monitor.find({ ...monitorFilter, softDeletedAt: null, expiresAt: { $ne: null, $lte: horizon } })
    .populate("projectId", "name")
    .sort({ expiresAt: 1 })
    .lean();
  res.json(
    monitors.map((m) => ({
      monitorId: String(m._id),
      name: m.name,
      url: m.url,
      project: projectName(m.projectId),
      expiresAt: m.expiresAt,
      daysRemaining: m.expiresAt ? Math.ceil((new Date(m.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null,
    })),
  );
}

export async function statusBoard(req: Request, res: Response): Promise<void> {
  const { monitorFilter } = await scope(req);
  const monitors = await Monitor.find(monitorFilter)
    .select("name url status enabled lastResponseTimeMs projectId")
    .populate("projectId", "name")
    .sort({ status: 1, name: 1 })
    .lean();
  const sparks = await sparklines(monitors.map((m) => m._id as Types.ObjectId));
  res.json(
    monitors.map((m) => ({
      monitorId: String(m._id),
      name: m.name,
      url: m.url,
      project: projectName(m.projectId),
      status: m.status,
      enabled: m.enabled,
      lastResponseTimeMs: m.lastResponseTimeMs ?? null,
      spark: sparks.get(String(m._id))?.spark ?? [],
    })),
  );
}
