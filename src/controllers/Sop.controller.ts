import type { Request, Response } from "express";
import { z } from "zod";
import { SopTemplate } from "../models/sopTemplate.model";
import { ApiError } from "../utils/ApiError";
import { writeAudit } from "../utils/audit";
import { isSuperAdmin } from "../utils/permissions";
import { SOP_FREQUENCIES } from "../utils/constants";

function assertSuperAdmin(req: Request): void {
  if (!isSuperAdmin(req.user!.permissions)) throw ApiError.forbidden("Only super admins can manage the SOP library");
}

const serialize = (t: {
  _id: unknown;
  name: string;
  description?: string;
  category?: string;
  steps?: string[];
  defaultFrequency?: string;
  archived?: boolean;
}) => ({
  id: String(t._id),
  name: t.name,
  description: t.description ?? "",
  category: t.category ?? "",
  steps: t.steps ?? [],
  defaultFrequency: t.defaultFrequency ?? "monthly",
  archived: !!t.archived,
});

export const sopTemplateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(4000).optional(),
  category: z.string().max(60).optional(),
  steps: z.array(z.string().max(500)).max(50).optional(),
  defaultFrequency: z.enum(SOP_FREQUENCIES).optional(),
});

/** List library SOPs (any authenticated user — owners pick from these). */
export async function listSopTemplates(req: Request, res: Response): Promise<void> {
  const includeArchived = String(req.query.includeArchived) === "true";
  const filter = includeArchived ? {} : { archived: false };
  const templates = await SopTemplate.find(filter).sort({ category: 1, name: 1 }).lean();
  res.json(templates.map(serialize));
}

export async function createSopTemplate(req: Request, res: Response): Promise<void> {
  assertSuperAdmin(req);
  const t = await SopTemplate.create({ ...req.body, createdBy: req.user!.id });
  await writeAudit(req, "sop.create", { targetType: "sop", targetId: String(t._id), metadata: { name: t.name } });
  res.status(201).json(serialize(t));
}

export async function updateSopTemplate(req: Request, res: Response): Promise<void> {
  assertSuperAdmin(req);
  const t = await SopTemplate.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true }).lean();
  if (!t) throw ApiError.notFound("SOP not found");
  await writeAudit(req, "sop.update", { targetType: "sop", targetId: req.params.id });
  res.json(serialize(t));
}

/** Archive (soft) — keeps it out of pickers but preserves attached-plan history. */
export async function archiveSopTemplate(req: Request, res: Response): Promise<void> {
  assertSuperAdmin(req);
  const t = await SopTemplate.findByIdAndUpdate(req.params.id, { archived: true }, { new: true }).lean();
  if (!t) throw ApiError.notFound("SOP not found");
  await writeAudit(req, "sop.archive", { targetType: "sop", targetId: req.params.id });
  res.json(serialize(t));
}
