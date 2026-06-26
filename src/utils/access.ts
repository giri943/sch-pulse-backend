import { Types } from "mongoose";
import { Monitor } from "../models/monitor.model";
import { Project } from "../models/project.model";
import { ProjectMember } from "../models/projectMember.model";
import { ApiError } from "./ApiError";
import { canWrite, isSuperAdmin, readScope } from "./permissions";
import type { AuthUser } from "./types";

type MonitorLike = { createdBy?: unknown; members?: unknown[]; projectId?: unknown };

/** Legacy per-monitor ownership: creator or tagged member. */
export function isOwnerOrMember(user: AuthUser, monitor: MonitorLike): boolean {
  if (String(monitor.createdBy ?? "") === user.id) return true;
  return (monitor.members ?? []).some((m) => String(m) === user.id);
}

/** Project ids the user is a member of (any role). */
async function memberProjectIds(userId: string): Promise<Types.ObjectId[]> {
  const rows = await ProjectMember.find({ userId }).select("projectId").lean();
  return rows.map((r) => r.projectId as Types.ObjectId);
}

/** Member of this project (any role)? Super admins always are. */
async function isProjectMember(user: AuthUser, projectId: unknown): Promise<boolean> {
  if (!projectId) return false;
  if (isSuperAdmin(user.permissions)) return true;
  return !!(await ProjectMember.findOne({ projectId, userId: user.id }).select("_id").lean());
}

/** Owner/editor of this project (can write)? Super admins can. */
async function hasProjectWriteRole(user: AuthUser, projectId: unknown): Promise<boolean> {
  if (!projectId) return false;
  if (isSuperAdmin(user.permissions)) return true;
  const m = await ProjectMember.findOne({ projectId, userId: user.id }).select("role").lean();
  return m?.role === "owner" || m?.role === "editor";
}

/**
 * Mongoose filter restricting a monitor query to what the user may read:
 * everything (read:all / super), or — for read:own — monitors in their projects
 * plus any they created or are tagged on (legacy).
 */
export async function monitorScopeFilter(user: AuthUser): Promise<Record<string, unknown>> {
  const scope = readScope(user.permissions, "monitor");
  if (scope === "all") return {};
  if (scope === "own") {
    const id = new Types.ObjectId(user.id);
    const projectIds = await memberProjectIds(user.id);
    return { $or: [{ projectId: { $in: projectIds } }, { createdBy: id }, { members: id }] };
  }
  return { _id: { $in: [] } };
}

// Per-request memo: req.user is a fresh object each request, so a WeakMap keyed
// by it naturally scopes the cache to one request (and is GC'd after). The
// dashboard resolves the same scoped id-set ~7× per load — this collapses that
// to a single query without changing any call site.
const accessibleIdsCache = new WeakMap<AuthUser, Promise<Types.ObjectId[] | null>>();

/** Monitor ids the user can access, or null when unrestricted (read:all / super). */
export function accessibleMonitorIds(user: AuthUser): Promise<Types.ObjectId[] | null> {
  let cached = accessibleIdsCache.get(user);
  if (!cached) {
    cached = computeAccessibleMonitorIds(user);
    accessibleIdsCache.set(user, cached);
  }
  return cached;
}

async function computeAccessibleMonitorIds(user: AuthUser): Promise<Types.ObjectId[] | null> {
  const scope = readScope(user.permissions, "monitor");
  if (scope === "all") return null;
  if (scope !== "own") return [];
  const id = new Types.ObjectId(user.id);
  const projectIds = await memberProjectIds(user.id);
  const monitors = await Monitor.find({ $or: [{ projectId: { $in: projectIds } }, { createdBy: id }, { members: id }] })
    .select("_id")
    .lean();
  return monitors.map((m) => m._id as Types.ObjectId);
}

/** Throw 403 unless the user may read this monitor. */
export async function assertCanReadMonitor(user: AuthUser, monitor: MonitorLike): Promise<void> {
  const scope = readScope(user.permissions, "monitor");
  if (scope === "all") return;
  if (scope === "own" && (isOwnerOrMember(user, monitor) || (await isProjectMember(user, monitor.projectId)))) return;
  throw ApiError.forbidden("You don't have access to this monitor");
}

/** Throw 403 unless the user may perform a write action on this monitor. */
export async function assertCanWriteMonitor(
  user: AuthUser,
  monitor: MonitorLike,
  action: "update" | "delete" | "run",
): Promise<void> {
  const owns = isOwnerOrMember(user, monitor) || (await hasProjectWriteRole(user, monitor.projectId));
  if (canWrite(user.permissions, "monitor", action, owns)) return;
  throw ApiError.forbidden("You don't have permission to modify this monitor");
}

/** Whether the user may resolve/annotate incidents on this monitor (owner/editor of its project, or legacy). */
export async function canWriteIncidentFor(user: AuthUser, monitor: MonitorLike): Promise<boolean> {
  const owns = isOwnerOrMember(user, monitor) || (await hasProjectWriteRole(user, monitor.projectId));
  return canWrite(user.permissions, "incident", "update", owns);
}

/**
 * Throw 403 unless the user may add a monitor to this project. The default
 * "General" project is open to anyone who can create monitors; other projects
 * require owner/editor membership.
 */
export async function assertCanCreateInProject(user: AuthUser, projectId: unknown): Promise<void> {
  if (isSuperAdmin(user.permissions)) return;
  if (!user.permissions.includes("monitor:create")) throw ApiError.forbidden("You don't have permission to create monitors");
  if (!projectId) throw ApiError.badRequest("A project is required");
  const project = await Project.findById(projectId).select("isSystem").lean();
  if (project?.isSystem) return;
  if (await hasProjectWriteRole(user, projectId)) return;
  throw ApiError.forbidden("You can only add monitors to projects you own or can edit");
}
