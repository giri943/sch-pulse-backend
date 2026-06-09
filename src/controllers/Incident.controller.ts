import type { Request, Response } from "express";
import { Incident } from "../models/incident.model";
import { Monitor } from "../models/monitor.model";
import { ApiError } from "../utils/ApiError";
import { paginate, pageParams } from "../utils/response";
import { parseSort, skip } from "../utils/query";
import { writeAudit } from "../utils/audit";

export async function listIncidents(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const q = req.query as Record<string, string>;
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.monitorId) filter.monitorId = q.monitorId;

  const [data, total] = await Promise.all([
    Incident.find(filter)
      .sort(parseSort(q.sort ?? "-startedAt"))
      .skip(skip(page, limit))
      .limit(limit)
      .populate("monitorId", "name url")
      .lean(),
    Incident.countDocuments(filter),
  ]);
  res.json(paginate(data, total, page, limit));
}

export async function getIncident(req: Request, res: Response): Promise<void> {
  const incident = await Incident.findById(req.params.id)
    .populate("monitorId", "name url type")
    .lean();
  if (!incident) throw ApiError.notFound("Incident not found");
  res.json(incident);
}

export async function updateIncident(req: Request, res: Response): Promise<void> {
  const update: Record<string, unknown> = {};
  if (req.body.rootCauseNotes !== undefined) update.rootCauseNotes = req.body.rootCauseNotes;
  if (req.body.resolutionNotes !== undefined) update.resolutionNotes = req.body.resolutionNotes;
  if (req.body.acknowledge) update.acknowledgedBy = req.user!.id;

  const incident = await Incident.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
  if (!incident) throw ApiError.notFound("Incident not found");
  await writeAudit(req, "incident.update", { targetType: "incident", targetId: req.params.id });
  res.json(incident);
}

export async function resolveIncident(req: Request, res: Response): Promise<void> {
  const incident = await Incident.findById(req.params.id);
  if (!incident) throw ApiError.notFound("Incident not found");
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
