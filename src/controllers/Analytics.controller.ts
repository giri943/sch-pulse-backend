import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Incident } from "../models/incident.model";
import { UptimeStat } from "../models/uptimeStat.model";
import { Monitor } from "../models/monitor.model";
import { ApiError } from "../utils/ApiError";
import { assertCanReadMonitor } from "../utils/access";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

async function computeMetrics(match: Record<string, unknown>, incidentMatch: Record<string, unknown>) {
  const from = new Date(Date.now() - THIRTY_DAYS);
  const [agg] = await UptimeStat.aggregate([
    { $match: { ...match, bucketStart: { $gte: from } } },
    {
      $group: {
        _id: null,
        ups: { $sum: "$ups" },
        downs: { $sum: "$downs" },
        count: { $sum: "$count" },
        sumResponseMs: { $sum: "$sumResponseMs" },
      },
    },
  ]);
  const incidentFrequency = await Incident.countDocuments({
    ...incidentMatch,
    startedAt: { $gte: from },
  });
  const count = agg?.count ?? 0;
  return {
    uptimePct: count ? Number(((agg.ups / count) * 100).toFixed(3)) : 100,
    avgResponseMs: count ? Math.round(agg.sumResponseMs / count) : null,
    monthlyDowntimeChecks: agg?.downs ?? 0,
    incidentFrequency,
    windowDays: 30,
  };
}

export async function monitorAnalytics(req: Request, res: Response): Promise<void> {
  const monitor = await Monitor.findById(req.params.id).select("createdBy members projectId").lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  await assertCanReadMonitor(req.user!, monitor);
  const id = new Types.ObjectId(req.params.id);
  res.json(await computeMetrics({ monitorId: id }, { monitorId: id }));
}
