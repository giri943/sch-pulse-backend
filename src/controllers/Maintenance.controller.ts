import type { Request, Response } from "express";
import { z } from "zod";
import { MaintenanceWindow } from "../models/maintenanceWindow.model";
import { MaintenancePolicy } from "../models/maintenancePolicy.model";
import { Monitor } from "../models/monitor.model";
import { ApiError } from "../utils/ApiError";
import { writeAudit } from "../utils/audit";
import { assertCanWriteMonitor, assertCanReadMonitor, accessibleProjectIds } from "../utils/access";
import { projectRole } from "../utils/projectAccess";
import { isSuperAdmin } from "../utils/permissions";
import { invalidateMaintenanceCache } from "../services/monitoring/maintenance";
import { uploadsEnabled, viewUrlFor } from "../services/s3";
import { sanitizeNoteHtml } from "../utils/sanitizeNotes";
import { notifyMaintenanceMentions } from "../services/maintenanceNotify";
import { publish } from "../services/realtime";
import { createNotifications } from "../services/notify";
import { ProjectMember } from "../models/projectMember.model";
import type { MaintenanceWindowDoc } from "../models/maintenanceWindow.model";

const GLOBAL = "global";
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "invalid id");
const toIdList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(String).filter((s) => /^[0-9a-fA-F]{24}$/.test(s)))] : [];

/** Attach a short-lived signed URL for the proof screenshot (if any). */
async function serializeWindow(win: MaintenanceWindowDoc & { _id: unknown }): Promise<Record<string, unknown>> {
  const proofUrl = win.proofKey && uploadsEnabled() ? await viewUrlFor(win.proofKey) : null;
  return { ...win, proofUrl };
}

export const createMaintenanceSchema = z
  .object({
    scope: z.enum(["monitor", "project"]),
    monitorId: objectId.optional(),
    projectId: objectId.optional(),
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional(),
    durationMinutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
    reason: z.string().max(50000).optional(), // rich text (HTML) with embedded images
    reasonMentions: z.array(objectId).max(50).optional(),
    proofKey: z.string().max(500).optional(),
  })
  .refine((v) => (v.scope === "monitor" ? !!v.monitorId : !!v.projectId), {
    message: "monitorId is required for monitor scope; projectId for project scope",
  });

/** Ensure the caller may schedule/cancel maintenance on the given target. */
async function assertCanManageTarget(req: Request, scope: string, monitorId?: string | null, projectId?: string | null): Promise<void> {
  if (scope === "monitor") {
    const monitor = await Monitor.findById(monitorId).select("createdBy members projectId").lean();
    if (!monitor) throw ApiError.notFound("Monitor not found");
    await assertCanWriteMonitor(req.user!, monitor, "update");
  } else {
    if (!projectId) throw ApiError.badRequest("projectId is required");
    const role = await projectRole(req.user!, projectId);
    if (!(role === "owner" || role === "editor" || role === "super")) {
      throw ApiError.forbidden("Only project owners or editors can schedule project maintenance");
    }
  }
}

export async function createMaintenance(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof createMaintenanceSchema>;
  await assertCanManageTarget(req, body.scope, body.monitorId, body.projectId);

  const startAt = body.startAt ?? new Date();
  let endAt = body.endAt;
  if (!endAt) {
    const policy = await MaintenancePolicy.findOne({ key: GLOBAL }).lean();
    const mins = body.durationMinutes ?? policy?.defaultDurationMinutes ?? 60;
    endAt = new Date(startAt.getTime() + mins * 60_000);
  }
  if (endAt.getTime() <= startAt.getTime()) throw ApiError.badRequest("End time must be after the start time");

  const reason = sanitizeNoteHtml(body.reason); // rich text — strip anything unsafe
  const reasonMentions = toIdList(body.reasonMentions);

  const win = await MaintenanceWindow.create({
    scope: body.scope,
    monitorId: body.scope === "monitor" ? body.monitorId : null,
    projectId: body.scope === "project" ? body.projectId : null,
    startAt,
    endAt,
    reason,
    reasonMentions,
    proofKey: body.proofKey ?? null,
    createdBy: req.user!.id,
    source: "manual",
  });
  invalidateMaintenanceCache(); // take effect on the next check
  await writeAudit(req, "maintenance.create", { targetType: "maintenance", targetId: String(win._id), metadata: { scope: body.scope } });
  res.status(201).json(await serializeWindow(win.toObject()));
  publish("maintenance", "monitors", "dashboard");

  // Notify the target's audience that maintenance was scheduled (beyond @-mentions).
  void (async () => {
    let audience: unknown[] = [];
    let name = "a project";
    if (body.scope === "monitor" && body.monitorId) {
      const m = await Monitor.findById(body.monitorId).select("name members createdBy").lean();
      if (m) {
        name = m.name;
        audience = [...((m.members as unknown[]) ?? []), ...(m.createdBy ? [m.createdBy] : [])];
      }
    } else if (body.projectId) {
      const members = await ProjectMember.find({ projectId: body.projectId }).distinct("userId");
      audience = members;
    }
    await createNotifications(
      audience,
      { type: "maintenance", title: `Maintenance scheduled on ${name}`, body: `${startAt.toLocaleString()} → ${endAt!.toLocaleString()}`, link: body.monitorId ? `/monitors/${body.monitorId}?tab=maintenance` : "/projects" },
      { excludeUserId: req.user!.id },
    );
  })();

  // Notify tagged users (fire-and-forget, after the response).
  if (reasonMentions.length) {
    void notifyMaintenanceMentions({
      scope: body.scope,
      monitorId: body.monitorId,
      projectId: body.projectId,
      actorId: req.user!.id,
      actorName: req.user!.name,
      userIds: reasonMentions,
      startAt,
      endAt,
      reason,
    });
  }
}

export async function listMaintenance(req: Request, res: Response): Promise<void> {
  const monitorId = req.query.monitorId ? String(req.query.monitorId) : null;
  const projectId = req.query.projectId ? String(req.query.projectId) : null;
  const filter: Record<string, unknown> = {};

  if (monitorId) {
    const monitor = await Monitor.findById(monitorId).select("createdBy members projectId").lean();
    if (!monitor) throw ApiError.notFound("Monitor not found");
    await assertCanReadMonitor(req.user!, monitor);
    // The monitor's own windows + any project-wide window covering it.
    filter.$or = [{ monitorId }, { scope: "project", projectId: monitor.projectId }];
  } else if (projectId) {
    const allowed = await accessibleProjectIds(req.user!);
    if (allowed !== null && !allowed.some((p) => String(p) === projectId)) throw ApiError.forbidden("You don't have access to this project");
    filter.projectId = projectId;
  } else {
    throw ApiError.badRequest("monitorId or projectId is required");
  }

  const windows = await MaintenanceWindow.find(filter).sort({ startAt: -1 }).limit(100).lean();
  res.json(await Promise.all(windows.map((w) => serializeWindow(w as MaintenanceWindowDoc & { _id: unknown }))));
}

export async function cancelMaintenance(req: Request, res: Response): Promise<void> {
  const win = await MaintenanceWindow.findById(req.params.id);
  if (!win) throw ApiError.notFound("Maintenance window not found");
  await assertCanManageTarget(req, win.scope, win.monitorId ? String(win.monitorId) : undefined, win.projectId ? String(win.projectId) : undefined);

  if (!win.canceledAt) {
    win.canceledAt = new Date();
    await win.save();
    invalidateMaintenanceCache();
  }
  await writeAudit(req, "maintenance.cancel", { targetType: "maintenance", targetId: String(win._id) });
  res.json(win);
  publish("maintenance", "monitors", "dashboard");
}

// ── Default-duration policy (super-admin) ────────────────────────────────────
export const maintenancePolicyUpdateSchema = z.object({
  defaultDurationMinutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
});

function assertSuperAdmin(req: Request): void {
  if (!isSuperAdmin(req.user!.permissions)) throw ApiError.forbidden("Only super admins can manage maintenance settings");
}

export async function getMaintenancePolicy(_req: Request, res: Response): Promise<void> {
  // Readable by any authenticated user — the scheduler form prefills the default.
  const p = await MaintenancePolicy.findOne({ key: GLOBAL }).lean();
  res.json({ defaultDurationMinutes: p?.defaultDurationMinutes ?? 60 });
}

export async function updateMaintenancePolicy(req: Request, res: Response): Promise<void> {
  assertSuperAdmin(req);
  const p = await MaintenancePolicy.findOneAndUpdate(
    { key: GLOBAL },
    { $set: req.body },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  await writeAudit(req, "settings.maintenance.update", { targetType: "settings", metadata: req.body });
  res.json({ defaultDurationMinutes: p?.defaultDurationMinutes ?? 60 });
}

// ── Deploy-token endpoints (CI/CD, authenticated by X-Deploy-Token) ──────────
export const deployStartSchema = z.object({
  monitorId: objectId.optional(),
  durationMinutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
  reason: z.string().max(500).optional(),
});

export async function startDeployMaintenance(req: Request, res: Response): Promise<void> {
  const projectId = req.deployToken!.projectId;
  const body = req.body as z.infer<typeof deployStartSchema>;

  let scope: "monitor" | "project" = "project";
  if (body.monitorId) {
    const m = await Monitor.findById(body.monitorId).select("projectId").lean();
    if (!m || String(m.projectId) !== projectId) throw ApiError.forbidden("That monitor isn't in this token's project");
    scope = "monitor";
  }

  const startAt = new Date();
  const policy = await MaintenancePolicy.findOne({ key: GLOBAL }).lean();
  const mins = body.durationMinutes ?? policy?.defaultDurationMinutes ?? 60;
  const endAt = new Date(startAt.getTime() + mins * 60_000);

  const win = await MaintenanceWindow.create({
    scope,
    monitorId: scope === "monitor" ? body.monitorId : null,
    projectId: scope === "project" ? projectId : null,
    startAt,
    endAt,
    reason: body.reason || "Deploy in progress",
    source: "deploy-token",
    createdBy: null,
  });
  invalidateMaintenanceCache();
  res.status(201).json({ id: String(win._id), scope, startAt, endAt });
  publish("maintenance", "monitors", "dashboard");
}

export async function endDeployMaintenance(req: Request, res: Response): Promise<void> {
  const projectId = req.deployToken!.projectId;
  const now = new Date();
  const monitorIds = await Monitor.find({ projectId }).distinct("_id");
  const result = await MaintenanceWindow.updateMany(
    {
      source: "deploy-token",
      canceledAt: null,
      endAt: { $gte: now },
      $or: [{ projectId }, { monitorId: { $in: monitorIds } }],
    },
    { canceledAt: now },
  );
  invalidateMaintenanceCache();
  res.json({ ended: result.modifiedCount ?? 0 });
  publish("maintenance", "monitors", "dashboard");
}
