import { Types } from "mongoose";
import { UptimeStat } from "../models/uptimeStat.model";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Spark {
  /** Hourly average response time (ms) over the last 24h, chronological. */
  spark: number[];
  /** Overall 24h uptime percentage; null when there's no data yet. */
  uptime24h: number | null;
}

/**
 * Last-24h sparkline (hourly avg response time) + uptime%, keyed by monitor id.
 * One aggregation across all ids — no per-monitor round-trips.
 */
export async function sparklines(ids: Types.ObjectId[]): Promise<Map<string, Spark>> {
  if (!ids.length) return new Map();
  const since = new Date(Date.now() - DAY_MS);
  const rows = await UptimeStat.aggregate<{ _id: Types.ObjectId; spark: number[]; ups: number; cnt: number }>([
    { $match: { monitorId: { $in: ids }, bucketStart: { $gte: since } } },
    { $sort: { bucketStart: 1 } },
    {
      $group: {
        _id: "$monitorId",
        spark: { $push: { $cond: [{ $gt: ["$count", 0] }, { $round: [{ $divide: ["$sumResponseMs", "$count"] }, 0] }, 0] } },
        ups: { $sum: "$ups" },
        cnt: { $sum: "$count" },
      },
    },
  ]);
  return new Map(
    rows.map((r) => [String(r._id), { spark: r.spark, uptime24h: r.cnt > 0 ? Math.round((r.ups / r.cnt) * 1000) / 10 : null }]),
  );
}
