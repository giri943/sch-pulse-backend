import type { Request, Response } from "express";
import { z } from "zod";
import { RcaReminderPolicy } from "../models/rcaReminderPolicy.model";
import { ApiError } from "../utils/ApiError";
import { isSuperAdmin } from "../utils/permissions";
import { writeAudit } from "../utils/audit";

const GLOBAL = "global";

const MAX_MINUTES = 90 * 24 * 60; // 90 days

/** Zod schema for PUT /settings/rca-reminder (used by the validate middleware). */
export const rcaReminderUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  everyMinutes: z.number().int().min(1).max(MAX_MINUTES).optional(),
  windowMinutes: z.number().int().min(1).max(MAX_MINUTES).optional(),
});

function assertSuperAdmin(req: Request): void {
  if (!isSuperAdmin(req.user!.permissions)) {
    throw ApiError.forbidden("Only super admins can manage the RCA-reminder policy");
  }
}

function serialize(p: { enabled?: boolean; everyMinutes?: number; windowMinutes?: number } | null) {
  return {
    enabled: p?.enabled ?? true,
    everyMinutes: p?.everyMinutes ?? 24 * 60,
    windowMinutes: p?.windowMinutes ?? 7 * 24 * 60,
  };
}

export async function getRcaReminderPolicy(req: Request, res: Response): Promise<void> {
  assertSuperAdmin(req);
  const policy = await RcaReminderPolicy.findOne({ key: GLOBAL }).lean();
  res.json(serialize(policy));
}

export async function updateRcaReminderPolicy(req: Request, res: Response): Promise<void> {
  assertSuperAdmin(req);
  const body = req.body as z.infer<typeof rcaReminderUpdateSchema>;
  const policy = await RcaReminderPolicy.findOneAndUpdate(
    { key: GLOBAL },
    { $set: body },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  await writeAudit(req, "settings.rcaReminder.update", { targetType: "settings", metadata: body });
  res.json(serialize(policy));
}
