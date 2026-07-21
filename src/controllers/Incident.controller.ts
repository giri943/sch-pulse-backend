import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Incident } from "../models/incident.model";
import { Monitor } from "../models/monitor.model";
import { User } from "../models/user.model";
import { ProjectMember } from "../models/projectMember.model";
import { ApiError } from "../utils/ApiError";
import { paginate, pageParams } from "../utils/response";
import { parseSort, skip } from "../utils/query";
import { writeAudit } from "../utils/audit";
import { accessibleMonitorIds, canWriteIncidentFor } from "../utils/access";
import { humanizeError } from "../utils/humanizeError";
import { sanitizeNoteHtml } from "../utils/sanitizeNotes";
import { notifyIncidentMentions } from "../services/incidentMentions";
import { keysFromHtml } from "../services/maintenanceCleanup";
import { deleteObjects } from "../services/s3";
import { publish } from "../services/realtime";

/** Normalize a body value to a de-duplicated list of valid ObjectId strings. */
function toObjectIdList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x)).filter((s) => Types.ObjectId.isValid(s)))];
}

/** Load the incident's monitor and 403 unless the user may write to it. Returns the monitor. */
async function assertIncidentWritable(req: Request, monitorId: unknown) {
  const monitor = await Monitor.findById(monitorId).select("createdBy members projectId").lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  if (!(await canWriteIncidentFor(req.user!, monitor))) {
    throw ApiError.forbidden("You don't have permission to modify this incident");
  }
  return monitor;
}

/**
 * Set of user ids who may be @-mentioned on a monitor's incidents: the project's
 * members plus the monitor owner and its tagged members. Used both to populate
 * the picker and to enforce that only these people can actually be tagged.
 */
async function mentionAudienceIds(monitor: { projectId?: unknown; members?: unknown[]; createdBy?: unknown }): Promise<Set<string>> {
  const ids = new Set<string>();
  if (monitor.projectId) {
    const members = await ProjectMember.find({ projectId: monitor.projectId }).distinct("userId");
    members.forEach((m) => ids.add(String(m)));
  }
  if (monitor.createdBy) ids.add(String(monitor.createdBy));
  ((monitor.members as unknown[] | undefined) ?? []).forEach((m) => ids.add(String(m)));
  return ids;
}

export async function listIncidents(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = {};
  // Coerce so query objects can't inject Mongo operators (e.g. ?status[$ne]=x).
  if (q.status) filter.status = String(q.status);

  // Scope to the monitors the user can see, optionally narrowed to one project.
  const ids = await accessibleMonitorIds(req.user!); // null = full access
  let allowedIds: string[] | null = ids === null ? null : ids.map(String);
  if (q.projectId && Types.ObjectId.isValid(q.projectId)) {
    const projIds = (await Monitor.find({ projectId: q.projectId }).distinct("_id")).map(String);
    allowedIds = allowedIds === null ? projIds : projIds.filter((p) => allowedIds!.includes(p));
  }
  if (q.monitorId) {
    // Explicit single monitor — honoured only if the caller may see it.
    const monitorId = String(q.monitorId);
    filter.monitorId = allowedIds && !allowedIds.includes(monitorId) ? { $in: [] } : monitorId;
  } else if (allowedIds !== null) {
    filter.monitorId = { $in: allowedIds };
  }

  const [data, total] = await Promise.all([
    Incident.find(filter)
      .sort(parseSort(q.sort ?? "-startedAt"))
      .skip(skip(page, limit))
      .limit(limit)
      .populate({ path: "monitorId", select: "name url projectId", populate: { path: "projectId", select: "name" } })
      .lean(),
    Incident.countDocuments(filter),
  ]);
  res.json(paginate(data, total, page, limit));
}

export async function getIncident(req: Request, res: Response): Promise<void> {
  const incident = await Incident.findById(req.params.id).populate("monitorId", "name url type").lean();
  if (!incident) throw ApiError.notFound("Incident not found");

  const ids = await accessibleMonitorIds(req.user!);
  if (ids !== null) {
    const monitorId = (incident.monitorId as { _id?: unknown })?._id ?? incident.monitorId;
    if (!ids.some((id) => String(id) === String(monitorId))) {
      throw ApiError.forbidden("You don't have access to this incident");
    }
  }
  // Plain-language explanation of the failure for non-technical readers (additive;
  // the raw trigger.statusCode/error are unchanged).
  const humanized = humanizeError({ statusCode: incident.trigger?.statusCode, error: incident.trigger?.error, server: incident.trigger?.server });
  res.json({ ...incident, humanized });
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Users who may be @-mentioned on this incident: only people attached to the
 * incident's project (project members) plus the monitor's owner and tagged
 * members. The project is derived server-side from the incident, so the client
 * can't widen the audience. Optional ?q= narrows by name/email.
 */
export async function getMentionableUsers(req: Request, res: Response): Promise<void> {
  const incident = await Incident.findById(req.params.id).select("monitorId").lean();
  if (!incident) throw ApiError.notFound("Incident not found");

  const monitor = await Monitor.findById(incident.monitorId).select("projectId members createdBy").lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");

  // Same access gate as getIncident — you must be able to see the incident.
  const accessible = await accessibleMonitorIds(req.user!);
  if (accessible !== null && !accessible.some((mid) => String(mid) === String(monitor._id))) {
    throw ApiError.forbidden("You don't have access to this incident");
  }

  const ids = await mentionAudienceIds(monitor);
  if (!ids.size) {
    res.json([]);
    return;
  }

  const q = String(req.query.q ?? "").trim().slice(0, 100);
  const filter: Record<string, unknown> = { _id: { $in: [...ids] }, status: "active" };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const users = await User.find(filter).select("name email avatarUrl").limit(10).lean();
  res.json(users.map((u) => ({ id: String(u._id), name: u.name, email: u.email, avatarUrl: u.avatarUrl ?? null })));
}

export async function updateIncident(req: Request, res: Response): Promise<void> {
  const incident = await Incident.findById(req.params.id);
  if (!incident) throw ApiError.notFound("Incident not found");
  const monitor = await assertIncidentWritable(req, incident.monitorId);

  // Mentions already stored on this incident (used to notify only the NEW ones).
  const before = new Set<string>([
    ...(incident.rootCauseMentions ?? []).map(String),
    ...(incident.resolutionMentions ?? []).map(String),
  ]);
  // Image keys referenced before this edit — anything dropped from the SAVED
  // notes gets cleaned from S3 below (safe: only on persisted removal).
  const imageKeysBefore = new Set<string>([
    ...keysFromHtml(incident.rootCauseNotes),
    ...keysFromHtml(incident.resolutionNotes),
  ]);

  // Notes are rich text (TipTap HTML) — sanitize before storing to prevent stored XSS.
  if (req.body.rootCauseNotes !== undefined) incident.rootCauseNotes = sanitizeNoteHtml(req.body.rootCauseNotes);
  if (req.body.resolutionNotes !== undefined) incident.resolutionNotes = sanitizeNoteHtml(req.body.resolutionNotes);
  // Only people on this incident's project may be tagged — filter server-side so a
  // crafted request can't notify someone outside the project.
  if (req.body.rootCauseMentions !== undefined || req.body.resolutionMentions !== undefined) {
    const audience = await mentionAudienceIds(monitor);
    if (req.body.rootCauseMentions !== undefined)
      incident.rootCauseMentions = toObjectIdList(req.body.rootCauseMentions).filter((x) => audience.has(x)) as never;
    if (req.body.resolutionMentions !== undefined)
      incident.resolutionMentions = toObjectIdList(req.body.resolutionMentions).filter((x) => audience.has(x)) as never;
  }
  if (req.body.acknowledge) incident.acknowledgedBy = req.user!.id as never;
  await incident.save();
  await writeAudit(req, "incident.update", { targetType: "incident", targetId: req.params.id });
  res.json(incident);
  publish("incidents", "monitors", "dashboard");

  // Clean up images removed from the saved notes (fire-and-forget).
  const imageKeysAfter = new Set<string>([...keysFromHtml(incident.rootCauseNotes), ...keysFromHtml(incident.resolutionNotes)]);
  const removedKeys = [...imageKeysBefore].filter((k) => !imageKeysAfter.has(k));
  if (removedKeys.length) void deleteObjects(removedKeys);

  // Notify newly-added mentions only (union of both note fields minus what was
  // already stored). Fire-and-forget after the response — never blocks the save.
  const after = new Set<string>([
    ...(incident.rootCauseMentions ?? []).map(String),
    ...(incident.resolutionMentions ?? []).map(String),
  ]);
  const newlyAdded = [...after].filter((id) => !before.has(id));
  if (newlyAdded.length) {
    void notifyIncidentMentions({
      incidentId: req.params.id,
      monitorId: incident.monitorId,
      actorId: req.user!.id,
      actorName: req.user!.name,
      newUserIds: newlyAdded,
    });
  }
}

export async function resolveIncident(req: Request, res: Response): Promise<void> {
  const incident = await Incident.findById(req.params.id);
  if (!incident) throw ApiError.notFound("Incident not found");
  await assertIncidentWritable(req, incident.monitorId);
  if (incident.status === "resolved") throw ApiError.badRequest("Incident already resolved");

  const resolvedAt = new Date();
  incident.status = "resolved";
  incident.resolvedAt = resolvedAt;
  incident.durationSec = Math.round((resolvedAt.getTime() - incident.startedAt.getTime()) / 1000);
  if (req.body?.resolutionNotes) incident.resolutionNotes = req.body.resolutionNotes;
  await incident.save();

  await Monitor.findByIdAndUpdate(incident.monitorId, {
    currentIncidentId: null,
    consecutiveFailures: 0,
    status: "operational",
  });
  await writeAudit(req, "incident.resolve", { targetType: "incident", targetId: req.params.id });
  res.json(incident);
  publish("incidents", "monitors", "dashboard", "projects");
}
