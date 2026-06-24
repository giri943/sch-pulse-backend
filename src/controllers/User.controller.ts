import type { Request, Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { User } from "../models/user.model";
import { Role } from "../models/role.model";
import { ApiError } from "../utils/ApiError";
import { hashPassword } from "../utils/password";
import { WILDCARD } from "../utils/permissions";
import { paginate, pageParams } from "../utils/response";
import { skip } from "../utils/query";
import { writeAudit } from "../utils/audit";
import { config } from "../config";
import { logger } from "../config/logger";
import { sendEmail, userInviteEmail } from "../services/mailer";

/** Invite (set-password) link validity — longer than a normal reset so people have time. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Escape user input before using it in a RegExp (prevents injection / ReDoS). */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lightweight typeahead for tagging users on a monitor. */
export async function searchUsers(req: Request, res: Response): Promise<void> {
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  const rx = new RegExp(escapeRegex(q), "i");
  const filter = q ? { $or: [{ name: rx }, { email: rx }] } : {};
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
  const role = await Role.findById(roleId).select("name").lean();
  if (!role) throw ApiError.badRequest("Invalid role");

  const user = await User.create({
    name,
    email,
    role: roleId,
    authProvider: "local",
    // Password is optional — when omitted the user sets it via the invite link below.
    ...(password ? { passwordHash: await hashPassword(password) } : {}),
  });

  // Invite: a 7-day set-password token + a welcome email with the link.
  const rawToken = randomBytes(32).toString("hex");
  user.set("resetPasswordToken", createHash("sha256").update(rawToken).digest("hex"));
  user.set("resetPasswordExpires", new Date(Date.now() + INVITE_TTL_MS));
  await user.save();
  const setupUrl = `${config.appBaseUrl}/reset-password?token=${rawToken}`;
  if (!config.isProd) logger.info(`[dev] invite link for ${email}: ${setupUrl}`);
  void sendEmail(
    userInviteEmail({ to: [email], name, email, roleName: role.name, inviterName: req.user!.name, setupUrl }),
  );

  await writeAudit(req, "user.create", { targetType: "user", targetId: user.id });
  const populated = await User.findById(user._id).populate("role", "name").lean();
  res.status(201).json(publicUser(populated!));
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const target = await User.findById(req.params.id).populate<{ role: { _id: unknown; permissions?: string[] } }>(
    "role",
    "permissions",
  );
  if (!target) throw ApiError.notFound("User not found");

  // Self-protection: you can't change your own role or status (prevents
  // self-lockout and self-escalation; another admin must do it).
  const isSelf = String(target._id) === req.user!.id;
  if (isSelf && (req.body.roleId || req.body.status)) {
    throw ApiError.badRequest("You can't change your own role or status. Ask another administrator.");
  }

  const update: Record<string, unknown> = {};
  if (req.body.roleId) {
    if (!(await Role.findById(req.body.roleId))) throw ApiError.badRequest("Invalid role");
    update.role = req.body.roleId;
  }
  if (req.body.status) update.status = req.body.status;

  // Last-Super-Admin protection: don't allow demoting or disabling the only
  // remaining active Super Admin — that would lock everyone out of admin.
  const targetIsSuperAdmin = (target.role?.permissions ?? []).includes(WILDCARD);
  if (targetIsSuperAdmin) {
    let losesAdmin = req.body.status === "disabled";
    if (req.body.roleId) {
      const newRole = await Role.findById(req.body.roleId).lean();
      if (!(newRole?.permissions ?? []).includes(WILDCARD)) losesAdmin = true;
    }
    if (losesAdmin && (await countActiveSuperAdmins()) <= 1) {
      throw ApiError.badRequest("Cannot remove the last Super Admin. Assign another Super Admin first.");
    }
  }

  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).populate("role", "name").lean();
  if (!user) throw ApiError.notFound("User not found");
  await writeAudit(req, "user.update", { targetType: "user", targetId: req.params.id });
  res.json(publicUser(user));
}

/** Count active users whose role carries the wildcard (Super Admin) permission. */
async function countActiveSuperAdmins(): Promise<number> {
  const wildcardRoles = await Role.find({ permissions: WILDCARD }).select("_id").lean();
  if (!wildcardRoles.length) return 0;
  return User.countDocuments({ role: { $in: wildcardRoles.map((r) => r._id) }, status: "active" });
}
