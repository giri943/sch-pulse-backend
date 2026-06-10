import { Types } from "mongoose";
import { Monitor } from "../models/monitor.model";
import { ApiError } from "./ApiError";
import { canWrite, readScope } from "./permissions";
import type { AuthUser } from "./types";

type MonitorLike = { createdBy?: unknown; members?: unknown[] };

export function isOwnerOrMember(user: AuthUser, monitor: MonitorLike): boolean {
  if (String(monitor.createdBy ?? "") === user.id) return true;
  return (monitor.members ?? []).some((m) => String(m) === user.id);
}

/**
 * Mongoose filter restricting a *monitor* query to what the user may read.
 * Returns {} when the user has monitor:read:all (super-admin-like).
 */
export function monitorScopeFilter(user: AuthUser): Record<string, unknown> {
  const scope = readScope(user.permissions, "monitor");
  if (scope === "all") return {};
  if (scope === "own") {
    const id = new Types.ObjectId(user.id);
    return { $or: [{ createdBy: id }, { members: id }] };
  }
  // No read permission at all → match nothing.
  return { _id: { $in: [] } };
}

/**
 * Monitor ids the user can access, or null when unrestricted (read:all).
 * Used to scope incidents / dashboard / analytics queries.
 */
export async function accessibleMonitorIds(user: AuthUser): Promise<Types.ObjectId[] | null> {
  const scope = readScope(user.permissions, "monitor");
  if (scope === "all") return null; // no restriction
  if (scope !== "own") return []; // no access
  const id = new Types.ObjectId(user.id);
  const monitors = await Monitor.find({ $or: [{ createdBy: id }, { members: id }] })
    .select("_id")
    .lean();
  return monitors.map((m) => m._id as Types.ObjectId);
}

/** Throw 403 unless the user may read this monitor. */
export function assertCanReadMonitor(user: AuthUser, monitor: MonitorLike): void {
  const scope = readScope(user.permissions, "monitor");
  if (scope === "all") return;
  if (scope === "own" && isOwnerOrMember(user, monitor)) return;
  throw ApiError.forbidden("You don't have access to this monitor");
}

/** Throw 403 unless the user may perform a write action on this monitor. */
export function assertCanWriteMonitor(
  user: AuthUser,
  monitor: MonitorLike,
  action: "update" | "delete" | "run",
): void {
  if (canWrite(user.permissions, "monitor", action, isOwnerOrMember(user, monitor))) return;
  throw ApiError.forbidden("You don't have permission to modify this monitor");
}
