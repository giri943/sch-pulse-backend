import type { Types } from "mongoose";
import { ProjectMember, type ProjectRole } from "../models/projectMember.model";
import { ApiError } from "./ApiError";
import { isSuperAdmin } from "./permissions";
import type { AuthUser } from "./types";

export type EffectiveProjectRole = ProjectRole | "super" | null;

/** The user's effective role in a project: "super" for super admins, else their membership role (or null). */
export async function projectRole(user: AuthUser, projectId: string | Types.ObjectId): Promise<EffectiveProjectRole> {
  if (isSuperAdmin(user.permissions)) return "super";
  const m = await ProjectMember.findOne({ projectId, userId: user.id }).select("role").lean();
  return (m?.role as ProjectRole | undefined) ?? null;
}

export async function isProjectOwner(user: AuthUser, projectId: string | Types.ObjectId): Promise<boolean> {
  const r = await projectRole(user, projectId);
  return r === "super" || r === "owner";
}

/** Throw 403 unless the user is an owner of the project (or a super admin). */
export async function assertProjectOwner(user: AuthUser, projectId: string | Types.ObjectId): Promise<void> {
  if (!(await isProjectOwner(user, projectId))) {
    throw ApiError.forbidden("Only a project owner can manage members or requests");
  }
}
