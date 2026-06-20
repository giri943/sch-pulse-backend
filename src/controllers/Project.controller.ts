import type { Request, Response } from "express";
import { Project, GENERAL_PROJECT } from "../models/project.model";
import { Monitor } from "../models/monitor.model";
import { ApiError } from "../utils/ApiError";
import { writeAudit } from "../utils/audit";
import { paginate, pageParams } from "../utils/response";
import { skip } from "../utils/query";
import { ProjectMember } from "../models/projectMember.model";

const DOWN_COUNT = { $sum: { $cond: [{ $in: ["$status", ["down", "degraded"]] }, 1, 0] } };

const serialize = (
  p: { _id: unknown; name: string; description?: string; isSystem?: boolean },
  monitorCount = 0,
  downCount = 0,
) => ({
  id: String(p._id),
  name: p.name,
  description: p.description ?? "",
  isSystem: !!p.isSystem,
  monitorCount,
  downCount,
});

export async function listProjects(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const q = String((req.query.q as string) ?? "").trim();
  const filter: Record<string, unknown> = {};
  if (q) filter.name = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  const [projects, total] = await Promise.all([
    Project.find(filter).sort({ isSystem: -1, name: 1 }).skip(skip(page, limit)).limit(limit).lean(),
    Project.countDocuments(filter),
  ]);

  // One aggregation for counts + health, scoped to the page's projects.
  const counts = await Monitor.aggregate<{ _id: unknown; n: number; down: number }>([
    { $match: { softDeletedAt: null, projectId: { $in: projects.map((p) => p._id) } } },
    { $group: { _id: "$projectId", n: { $sum: 1 }, down: DOWN_COUNT } },
  ]);
  const map = new Map(counts.map((c) => [String(c._id), c]));

  const data = projects.map((p) => {
    const c = map.get(String(p._id));
    return serialize(p, c?.n ?? 0, c?.down ?? 0);
  });
  res.json(paginate(data, total, page, limit));
}

export async function getProject(req: Request, res: Response): Promise<void> {
  const project = await Project.findById(req.params.id).lean();
  if (!project) throw ApiError.notFound("Project not found");
  const [c] = await Monitor.aggregate<{ n: number; down: number }>([
    { $match: { softDeletedAt: null, projectId: project._id } },
    { $group: { _id: null, n: { $sum: 1 }, down: DOWN_COUNT } },
  ]);
  res.json(serialize(project, c?.n ?? 0, c?.down ?? 0));
}

export async function createProject(req: Request, res: Response): Promise<void> {
  const { name, description } = req.body;
  if (await Project.findOne({ name })) throw ApiError.conflict("A project with that name already exists");
  const project = await Project.create({ name, description: description ?? "", createdBy: req.user!.id });
  // The creator is the project's first owner.
  await ProjectMember.create({ projectId: project._id, userId: req.user!.id, role: "owner" });
  await writeAudit(req, "project.create", { targetType: "project", targetId: project.id });
  res.status(201).json(serialize(project));
}

export async function updateProject(req: Request, res: Response): Promise<void> {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound("Project not found");
  if (project.isSystem) throw ApiError.badRequest("The General project cannot be modified");

  if (req.body.name && req.body.name !== project.name) {
    if (await Project.findOne({ name: req.body.name })) throw ApiError.conflict("A project with that name already exists");
    project.name = req.body.name;
  }
  if (req.body.description !== undefined) project.description = req.body.description;
  await project.save();
  await writeAudit(req, "project.update", { targetType: "project", targetId: project.id });
  res.json(serialize(project));
}

export async function deleteProject(req: Request, res: Response): Promise<void> {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound("Project not found");
  if (project.isSystem) throw ApiError.badRequest("The General project cannot be deleted");

  // Move its monitors to General rather than orphaning them.
  const general = await Project.findOne({ name: GENERAL_PROJECT }).select("_id").lean();
  if (general) await Monitor.updateMany({ projectId: project._id }, { projectId: general._id });

  await project.deleteOne();
  await writeAudit(req, "project.delete", { targetType: "project", targetId: project.id });
  res.status(204).send();
}
