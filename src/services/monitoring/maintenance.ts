import { MaintenanceWindow } from "../../models/maintenanceWindow.model";

/**
 * Suppression check for the hot path (runs on every health check). Active
 * maintenance windows are rare and change infrequently, so we cache the set of
 * monitor/project ids currently under maintenance for a short TTL rather than
 * querying per check. Creating/canceling a window busts the cache immediately.
 */
let cache: { monitorIds: Set<string>; projectIds: Set<string>; at: number } | null = null;
const TTL_MS = 15_000;

async function refresh(now: number): Promise<{ monitorIds: Set<string>; projectIds: Set<string> }> {
  const nowDate = new Date(now);
  const active = await MaintenanceWindow.find({
    canceledAt: null,
    startAt: { $lte: nowDate },
    endAt: { $gte: nowDate },
  })
    .select("scope monitorId projectId")
    .lean();

  const monitorIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const w of active) {
    if (w.scope === "monitor" && w.monitorId) monitorIds.add(String(w.monitorId));
    if (w.scope === "project" && w.projectId) projectIds.add(String(w.projectId));
  }
  cache = { monitorIds, projectIds, at: now };
  return { monitorIds, projectIds };
}

/** True if this monitor (or its project) has an active maintenance window. */
export async function isUnderMaintenance(monitorId: unknown, projectId: unknown): Promise<boolean> {
  const now = Date.now();
  const sets = cache && now - cache.at < TTL_MS ? cache : await refresh(now);
  return sets.monitorIds.has(String(monitorId)) || (projectId != null && sets.projectIds.has(String(projectId)));
}

/** Drop the cache so a just-created/canceled window takes effect on the next check. */
export function invalidateMaintenanceCache(): void {
  cache = null;
}
