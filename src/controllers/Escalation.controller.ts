import type { Request, Response } from "express";
import { z } from "zod";
import { EscalationPolicy } from "../models/escalationPolicy.model";
import { ApiError } from "../utils/ApiError";
import { isSuperAdmin } from "../utils/permissions";
import { writeAudit } from "../utils/audit";

const GLOBAL = "global";

/** Zod schema for PUT /settings/escalation (used by the validate middleware). */
export const escalationUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  afterMinutes: z.number().int().min(1).max(1440).optional(),
  emails: z.array(z.string().email()).max(20).optional(),
});

function assertSuperAdmin(req: Request): void {
  if (!isSuperAdmin(req.user!.permissions)) {
    throw ApiError.forbidden("Only super admins can manage the escalation policy");
  }
}

function serialize(p: { enabled?: boolean; afterMinutes?: number; emails?: string[] } | null) {
  return { enabled: !!p?.enabled, afterMinutes: p?.afterMinutes ?? 60, emails: p?.emails ?? [] };
}

export async function getEscalationPolicy(req: Request, res: Response): Promise<void> {
  assertSuperAdmin(req);
  const policy = await EscalationPolicy.findOne({ key: GLOBAL }).lean();
  res.json(serialize(policy));
}

export async function updateEscalationPolicy(req: Request, res: Response): Promise<void> {
  assertSuperAdmin(req);
  const body = req.body as z.infer<typeof escalationUpdateSchema>;
  const policy = await EscalationPolicy.findOneAndUpdate(
    { key: GLOBAL },
    { $set: body },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  await writeAudit(req, "settings.escalation.update", { targetType: "settings", metadata: body });
  res.json(serialize(policy));
}
