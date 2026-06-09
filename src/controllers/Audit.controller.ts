import type { Request, Response } from "express";
import { AuditLog } from "../models/auditLog.model";
import { paginate, pageParams } from "../utils/response";
import { skip } from "../utils/query";

export async function listAuditLogs(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = {};
  if (q.action) filter.action = q.action;
  if (q.targetType) filter.targetType = q.targetType;
  if (q.actorId) filter.actorId = q.actorId;

  const [data, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip(page, limit)).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json(paginate(data, total, page, limit));
}
