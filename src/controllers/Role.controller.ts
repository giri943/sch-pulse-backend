import type { Request, Response } from "express";
import { Role } from "../models/role.model";
import { User } from "../models/user.model";
import { ApiError } from "../utils/ApiError";
import { ALL_PERMISSIONS, PERMISSION_CATALOG } from "../utils/permissions";
import { bustRoleCache } from "../middlewares/auth";
import { writeAudit } from "../utils/audit";

const validPerms = new Set<string>(ALL_PERMISSIONS);
const sanitize = (perms: unknown): string[] =>
  Array.isArray(perms) ? perms.filter((p): p is string => typeof p === "string" && validPerms.has(p)) : [];

const serialize = (r: { _id: unknown; name: string; description: string; permissions: string[]; isSystem: boolean }) => ({
  id: String(r._id),
  name: r.name,
  description: r.description,
  permissions: r.permissions,
  isSystem: r.isSystem,
});

/** The permission catalog the role-builder UI renders as checkboxes. */
export function permissionCatalog(_req: Request, res: Response): void {
  res.json(PERMISSION_CATALOG);
}

export async function listRoles(_req: Request, res: Response): Promise<void> {
  const roles = await Role.find({}).sort({ isSystem: -1, name: 1 }).lean();
  const counts = await User.aggregate<{ _id: unknown; n: number }>([
    { $group: { _id: "$role", n: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json(
    roles.map((r) => ({
      id: String(r._id),
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      isSystem: r.isSystem,
      userCount: countMap.get(String(r._id)) ?? 0,
    })),
  );
}

export async function createRole(req: Request, res: Response): Promise<void> {
  const { name, description } = req.body;
  if (await Role.findOne({ name })) throw ApiError.conflict("A role with that name already exists");
  const role = await Role.create({
    name,
    description: description ?? "",
    permissions: sanitize(req.body.permissions),
    isSystem: false,
  });
  await writeAudit(req, "role.create", { targetType: "role", targetId: role.id });
  res.status(201).json(serialize(role));
}

export async function updateRole(req: Request, res: Response): Promise<void> {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound("Role not found");
  if (role.isSystem) throw ApiError.badRequest("System roles cannot be modified");

  if (req.body.name) role.name = req.body.name;
  if (req.body.description !== undefined) role.description = req.body.description;
  if (req.body.permissions) role.permissions = sanitize(req.body.permissions);
  await role.save();
  bustRoleCache(role.id);
  await writeAudit(req, "role.update", { targetType: "role", targetId: role.id });
  res.json(serialize(role));
}

export async function deleteRole(req: Request, res: Response): Promise<void> {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound("Role not found");
  if (role.isSystem) throw ApiError.badRequest("System roles cannot be deleted");
  const inUse = await User.countDocuments({ role: role._id });
  if (inUse > 0) throw ApiError.conflict(`Role is assigned to ${inUse} user(s); reassign them first`);

  await role.deleteOne();
  bustRoleCache(role.id);
  await writeAudit(req, "role.delete", { targetType: "role", targetId: role.id });
  res.status(204).send();
}
