import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Incident } from "../models/incident.model";
import { Monitor } from "../models/monitor.model";
import { ApiError } from "../utils/ApiError";
import { paginate, pageParams } from "../utils/response";
import { parseSort, skip } from "../utils/query";
import { writeAudit } from "../utils/audit";
import { accessibleMonitorIds, canWriteIncidentFor } from "../utils/access";

/** Load the incident's monitor and 403 unless the user may write to it. */
async function assertIncidentWritable(req: Request, monitorId: unknown) {
  const monitor = await Monitor.findById(monitorId).select("createdBy members projectId").lean();
  if (!monitor) throw ApiError.notFound("Monitor not found");
  if (!(await canWriteIncidentFor(req.user!, monitor))) {
    throw ApiError.forbidden("You don't have permission to modify this incident");
  }
}

export async function listIncidents(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;

  // Scope to the monitors the user can see, optionally narrowed to one project.
  const ids = await accessibleMonitorIds(req.user!); // null = full access
  let allowedIds: string[] | null = ids === null ? null : ids.map(String);
  if (q.projectId && Types.ObjectId.isValid(q.projectId)) {
    const projIds = (await Monitor.find({ projectId: q.projectId }).distinct("_id")).map(String);
    allowedIds = allowedIds === null ? projIds : projIds.filter((p) => allowedIds!.includes(p));
  }
  if (q.monitorId) {
    // Explicit single monitor — honoured only if the caller may see it.
    filter.monitorId = allowedIds && !allowedIds.includes(String(q.monitorId)) ? { $in: [] } : q.monitorId;
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
  res.json(incident);
}

export async function updateIncident(req: Request, res: Response): Promise<void> {
  const incident = await Incident.findById(req.params.id);
  if (!incident) throw ApiError.notFound("Incident not found");
  await assertIncidentWritable(req, incident.monitorId);

  if (req.body.rootCauseNotes !== undefined) incident.rootCauseNotes = req.body.rootCauseNotes;
  if (req.body.resolutionNotes !== undefined) incident.resolutionNotes = req.body.resolutionNotes;
  if (req.body.acknowledge) incident.acknowledgedBy = req.user!.id as never;
  await incident.save();
  await writeAudit(req, "incident.update", { targetType: "incident", targetId: req.params.id });
  res.json(incident);
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
}
