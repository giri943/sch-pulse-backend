import type { Request } from "express";
import { AuditLog } from "../models/auditLog.model";
import { logger } from "../config/logger";

interface AuditExtra {
  targetType?: string;
  targetId?: string;
  actorEmail?: string;
  metadata?: Record<string, unknown>;
}

/** Fire-and-forget audit write derived from the request. Never blocks/fails the response. */
export async function writeAudit(req: Request, action: string, extra: AuditExtra = {}): Promise<void> {
  try {
    await AuditLog.create({
      actorId: req.user?.id ?? null,
      actorEmail: extra.actorEmail ?? req.user?.email ?? "system",
      action,
      ip: req.ip,
      userAgent: req.header("user-agent"),
      ...extra,
    });
  } catch (err) {
    logger.error({ err }, "Failed to write audit log");
  }
}
