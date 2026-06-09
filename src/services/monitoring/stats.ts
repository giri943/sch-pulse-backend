import { UptimeStat } from "../../models/uptimeStat.model";
import type { CheckResult } from "./types";

/** Truncate a date to the top of its hour. */
function hourBucket(d: Date): Date {
  const b = new Date(d);
  b.setMinutes(0, 0, 0);
  return b;
}

/** Increment the hourly uptime bucket for a monitor (upsert, concurrency-safe). */
export async function recordStat(monitorId: unknown, result: CheckResult, at: Date): Promise<void> {
  const bucketStart = hourBucket(at);
  const rt = result.responseTimeMs ?? 0;
  await UptimeStat.updateOne(
    { monitorId, bucketStart },
    {
      $setOnInsert: { monitorId, bucket: "hour", bucketStart },
      $inc: { ups: result.up ? 1 : 0, downs: result.up ? 0 : 1, count: 1, sumResponseMs: rt },
      $max: { maxResponseMs: rt },
    },
    { upsert: true },
  );
}
