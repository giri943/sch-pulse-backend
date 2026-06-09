import type { Request, Response } from "express";
import { User } from "../models/user.model";
import { ApiError } from "../utils/ApiError";
import { hashPassword } from "../utils/password";
import { paginate, pageParams } from "../utils/response";
import { skip } from "../utils/query";
import { writeAudit } from "../utils/audit";

export async function listUsers(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const [data, total] = await Promise.all([
    User.find({}).sort({ createdAt: -1 }).skip(skip(page, limit)).limit(limit).lean(),
    User.countDocuments({}),
  ]);
  res.json(paginate(data, total, page, limit));
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const existing = await User.findOne({ email: req.body.email });
  if (existing) throw ApiError.conflict("Email already in use");
  const user = await User.create({
    name: req.body.name,
    email: req.body.email,
    role: req.body.role,
    passwordHash: await hashPassword(req.body.password),
  });
  await writeAudit(req, "user.create", { targetType: "user", targetId: user.id });
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const user = await User.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
  if (!user) throw ApiError.notFound("User not found");
  await writeAudit(req, "user.update", { targetType: "user", targetId: req.params.id });
  res.json({
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
  });
}
