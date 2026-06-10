import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/ApiError";
import { verifyAccessToken } from "../utils/jwt";
import { User } from "../models/user.model";
import { Role, type RoleDoc } from "../models/role.model";
import { has, type Permission } from "../utils/permissions";
import { catchAsync } from "../utils/catchAsync";

// Small in-process cache so we don't refetch the role on every request.
const roleCache = new Map<string, { name: string; permissions: string[]; expires: number }>();
const ROLE_TTL_MS = 30_000;

export function bustRoleCache(roleId?: string): void {
  if (roleId) roleCache.delete(roleId);
  else roleCache.clear();
}

async function loadRole(roleId: string): Promise<{ name: string; permissions: string[] } | null> {
  const cached = roleCache.get(roleId);
  if (cached && cached.expires > Date.now()) return cached;
  const role = (await Role.findById(roleId).lean()) as RoleDoc | null;
  if (!role) return null;
  const entry = { name: role.name, permissions: role.permissions ?? [], expires: Date.now() + ROLE_TTL_MS };
  roleCache.set(roleId, entry);
  return entry;
}

/** Requires a valid access token; loads the user + role permissions onto req.user. */
export const authenticate = catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) throw ApiError.unauthorized("Missing access token");

  let payload;
  try {
    payload = verifyAccessToken(header.slice(7));
  } catch {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  const user = await User.findById(payload.sub).lean();
  if (!user || user.status !== "active") throw ApiError.unauthorized("Account not found or disabled");

  const role = await loadRole(String(user.role));
  if (!role) throw ApiError.unauthorized("Role not found");

  req.user = {
    id: String(user._id),
    email: user.email,
    name: user.name,
    roleId: String(user.role),
    roleName: role.name,
    permissions: role.permissions,
  };
  next();
});

/** Gate a route by a permission (any one of the provided keys). */
export function requirePermission(...keys: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(ApiError.unauthorized());
    if (keys.some((k) => has(req.user!.permissions, k))) return next();
    next(ApiError.forbidden("You don't have permission to do that"));
  };
}
