import type { Request, Response } from "express";
import { z } from "zod";
import { Monitor } from "../models/monitor.model";
import { apexOf, probeDomainExpiry } from "../services/monitoring/domainProbe";
import {
  domainRefreshIntervalMs,
  refreshDomainExpiries,
  type DomainRefreshStats,
  type LifecycleMonitor,
} from "../services/monitoring/lifecycle";
import { ApiError } from "../utils/ApiError";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const probeQuerySchema = z.object({ url: z.string().min(1) });

const resetSchema = z.object({
  monitorIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
  all: z.boolean().optional(),
  clearExpiry: z.boolean().optional(),
});

function toUrl(input: string): string {
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

async function domainMonitors(): Promise<LifecycleMonitor[]> {
  const live = (await Monitor.find({ softDeletedAt: null, enabled: true }).lean()) as unknown as LifecycleMonitor[];
  return live.filter((m) => m.monitoringScope !== "ssl");
}

/** Probe one domain against RDAP and return the raw outcome. No DB writes. */
export async function probeDomain(req: Request, res: Response): Promise<void> {
  const { url } = probeQuerySchema.parse(req.query);
  const target = toUrl(url.trim());
  const started = Date.now();
  const result = await probeDomainExpiry(target);
  res.json({
    input: url,
    resolvedUrl: target,
    apex: apexOf(target),
    elapsedMs: Date.now() - started,
    result: result.ok
      ? { ok: true, expiresAt: result.expiresAt.toISOString(), daysRemaining: Math.ceil((result.expiresAt.getTime() - Date.now()) / DAY) }
      : { ok: false, reason: result.reason },
  });
}

/**
 * Show the refresh tier for every domain-tracking monitor: what we have stored,
 * which tier it falls in, and whether it is due. Explains why a monitor is or
 * isn't being probed without needing to read the DB by hand.
 */
export async function domainTiers(_req: Request, res: Response): Promise<void> {
  const now = new Date();
  const monitors = await domainMonitors();

  const rows = monitors.map((m) => {
    const apex = apexOf(m.url);
    const expiresAt = m.domainExpiresAt ? new Date(m.domainExpiresAt) : null;
    const checkedAt = m.domainCheckedAt ? new Date(m.domainCheckedAt) : null;
    const intervalMs = domainRefreshIntervalMs(expiresAt, now);
    const age = now.getTime() - (checkedAt?.getTime() ?? 0);
    const daysRemaining = expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / DAY) : null;
    return {
      monitorId: String(m._id),
      name: m.name,
      apex,
      scope: m.monitoringScope ?? "full",
      domainExpiresAt: expiresAt?.toISOString() ?? null,
      daysRemaining,
      domainCheckedAt: checkedAt?.toISOString() ?? null,
      tier: !expiresAt ? "unknown" : daysRemaining !== null && daysRemaining <= 45 ? "hot" : "cold",
      intervalHours: Math.round(intervalMs / HOUR),
      due: age >= intervalMs,
      nextDueAt: checkedAt ? new Date(checkedAt.getTime() + intervalMs).toISOString() : null,
      warnedThresholds: m.domainWarnedThresholds ?? [],
    };
  });

  const uniqueApex = new Set(rows.map((r) => r.apex).filter(Boolean));
  const dueApex = new Set(rows.filter((r) => r.due).map((r) => r.apex).filter(Boolean));

  res.json({
    now: now.toISOString(),
    summary: {
      monitors: rows.length,
      uniqueDomains: uniqueApex.size,
      dueMonitors: rows.filter((r) => r.due).length,
      dueDomains: dueApex.size,
      probesThisRun: Math.min(dueApex.size, 20),
      tiers: {
        unknown: rows.filter((r) => r.tier === "unknown").length,
        hot: rows.filter((r) => r.tier === "hot").length,
        cold: rows.filter((r) => r.tier === "cold").length,
      },
    },
    monitors: rows,
  });
}

/** Run the real tiered refresh now and report what it did. Writes to the DB. */
export async function refreshDomains(_req: Request, res: Response): Promise<void> {
  const now = new Date();
  const monitors = await domainMonitors();
  const stats: DomainRefreshStats = { monitors: 0, due: 0, probed: 0, updated: 0, rateLimited: false, capped: false };
  const started = Date.now();
  const fresh = await refreshDomainExpiries(monitors, now, stats);
  res.json({
    elapsedMs: Date.now() - started,
    stats,
    refreshed: [...fresh].map(([apex, date]) => ({
      apex,
      expiresAt: date.toISOString(),
      daysRemaining: Math.ceil((date.getTime() - now.getTime()) / DAY),
    })),
  });
}

/**
 * Clear domainCheckedAt so monitors become due on the next pass. Used after a
 * deploy that fixes probing, since a failed probe still stamps the timestamp.
 */
export async function resetDomainChecks(req: Request, res: Response): Promise<void> {
  const body = resetSchema.parse(req.body ?? {});
  if (!body.all && !body.monitorIds?.length) {
    throw ApiError.badRequest("Pass monitorIds[] or all:true");
  }
  const filter = body.all ? { softDeletedAt: null } : { _id: { $in: body.monitorIds } };
  const unset: Record<string, ""> = { domainCheckedAt: "" };
  if (body.clearExpiry) unset.domainExpiresAt = "";

  const result = await Monitor.updateMany(filter, { $unset: unset });
  res.json({
    matched: result.matchedCount,
    modified: result.modifiedCount,
    cleared: Object.keys(unset),
  });
}
