import type { Request, Response } from "express";
import { User } from "../models/user.model";
import { Role } from "../models/role.model";
import { ApiError } from "../utils/ApiError";
import { hashPassword } from "../utils/password";
import { paginate, pageParams } from "../utils/response";
import { skip } from "../utils/query";
import { writeAudit } from "../utils/audit";

function publicUser(u: Record<string, unknown>) {
  const role = u.role as { _id?: unknown; name?: string } | undefined;
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    status: u.status,
    authProvider: u.authProvider,
    avatarUrl: u.avatarUrl ?? null,
    role: role && typeof role === "object" ? { id: String(role._id), name: role.name } : null,
  };
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const [data, total] = await Promise.all([
    User.find({}).populate("role", "name").sort({ createdAt: -1 }).skip(skip(page, limit)).limit(limit).lean(),
    User.countDocuments({}),
  ]);
  res.json(paginate(data.map(publicUser), total, page, limit));
}

/** Lightweight typeahead for tagging users on a monitor. */
export async function searchUsers(req: Request, res: Response): Promise<void> {
  const q = String(req.query.q ?? "").trim();
  const filter = q ? { $or: [{ name: new RegExp(q, "i") }, { email: new RegExp(q, "i") }] } : {};
  const users = await User.find({ status: "active", ...filter })
    .select("name email avatarUrl")
    .limit(10)
    .lean();
  res.json(
    users.map((u) => ({ id: String(u._id), name: u.name, email: u.email, avatarUrl: u.avatarUrl ?? null })),
  );
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const { name, email, password, roleId } = req.body;
  if (await User.findOne({ email })) throw ApiError.conflict("Email already in use");
  if (!(await Role.findById(roleId))) throw ApiError.badRequest("Invalid role");

  const user = await User.create({
    name,
    email,
    role: roleId,
    authProvider: "local",
    passwordHash: await hashPassword(password),
  });
  await writeAudit(req, "user.create", { targetType: "user", targetId: user.id });
  const populated = await User.findById(user._id).populate("role", "name").lean();
  res.status(201).json(publicUser(populated!));
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const update: Record<string, unknown> = {};
  if (req.body.roleId) {
    if (!(await Role.findById(req.body.roleId))) throw ApiError.badRequest("Invalid role");
    update.role = req.body.roleId;
  }
  if (req.body.status) update.status = req.body.status;

  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).populate("role", "name").lean();
  if (!user) throw ApiError.notFound("User not found");
  await writeAudit(req, "user.update", { targetType: "user", targetId: req.params.id });
  res.json(publicUser(user));
}
