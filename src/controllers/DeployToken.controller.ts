import type { Request, Response } from "express";
import { z } from "zod";
import { DeployToken } from "../models/deployToken.model";
import { ApiError } from "../utils/ApiError";
import { writeAudit } from "../utils/audit";
import { projectRole } from "../utils/projectAccess";
import { generateDeployToken } from "../utils/deployToken";

export const createDeployTokenSchema = z.object({ name: z.string().max(100).optional() });

async function assertProjectOwner(req: Request, projectId: string): Promise<void> {
  const role = await projectRole(req.user!, projectId);
  if (!(role === "owner" || role === "super")) throw ApiError.forbidden("Only project owners can manage deploy tokens");
}

export async function createDeployToken(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  await assertProjectOwner(req, projectId);
  const { raw, hash, prefix } = generateDeployToken();
  const doc = await DeployToken.create({ projectId, name: req.body.name ?? "", tokenHash: hash, prefix, createdBy: req.user!.id });
  await writeAudit(req, "deployToken.create", { targetType: "project", targetId: projectId });
  // The plaintext token is returned ONCE here and never stored.
  res.status(201).json({ id: String(doc._id), name: doc.name, prefix: doc.prefix, token: raw });
}

export async function listDeployTokens(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  await assertProjectOwner(req, projectId);
  const tokens = await DeployToken.find({ projectId, revokedAt: null }).sort({ createdAt: -1 }).lean();
  res.json(tokens.map((t) => ({ id: String(t._id), name: t.name, prefix: t.prefix, lastUsedAt: t.lastUsedAt ?? null, createdAt: (t as { createdAt?: Date }).createdAt ?? null })));
}

export async function revokeDeployToken(req: Request, res: Response): Promise<void> {
  const token = await DeployToken.findById(req.params.id);
  if (!token) throw ApiError.notFound("Deploy token not found");
  await assertProjectOwner(req, String(token.projectId));
  if (!token.revokedAt) {
    token.revokedAt = new Date();
    await token.save();
  }
  await writeAudit(req, "deployToken.revoke", { targetType: "project", targetId: String(token.projectId) });
  res.json({ ok: true });
}
