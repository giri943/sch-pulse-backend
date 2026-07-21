import type { Request, Response } from "express";
import { Project } from "../models/project.model";
import { Monitor } from "../models/monitor.model";
import { Check } from "../models/check.model";
import { Incident } from "../models/incident.model";
import { UptimeStat } from "../models/uptimeStat.model";
import { ApiError } from "../utils/ApiError";
import { writeAudit } from "../utils/audit";
import { paginate, pageParams } from "../utils/response";
import { skip } from "../utils/query";
import { ProjectMember } from "../models/projectMember.model";
import { ProjectJoinRequest } from "../models/projectJoinRequest.model";
import { projectRole } from "../utils/projectAccess";
import { accessibleProjectIds } from "../utils/access";
import { DeployToken } from "../models/deployToken.model";
import { purgeMaintenanceFor, purgeIncidentImagesFor } from "../services/maintenanceCleanup";
import { publish } from "../services/realtime";

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
  const and: Record<string, unknown>[] = [];

  // Non-super-admins see only their own projects (+ system + projects with a
  // monitor they can access). To join others they use "Find a project to join".
  const allowedIds = await accessibleProjectIds(req.user!);
  if (allowedIds !== null) and.push({ _id: { $in: allowedIds } });

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    // Match the project name OR any project that contains a monitor whose url/name matches.
    const monitorProjectIds = await Monitor.find({ softDeletedAt: null, $or: [{ url: rx }, { name: rx }] }).distinct("projectId");
    and.push({ $or: [{ name: rx }, { _id: { $in: monitorProjectIds } }] });
  }
  const filter: Record<string, unknown> = and.length ? { $and: and } : {};

  const [projects, total] = await Promise.all([
    Project.find(filter).sort({ isSystem: -1, name: 1 }).skip(skip(page, limit)).limit(limit).lean(),
    Project.countDocuments(filter),
  ]);

  const projectIds = projects.map((p) => p._id);

  // One aggregation for counts + health, scoped to the page's projects.
  const counts = await Monitor.aggregate<{ _id: unknown; n: number; down: number }>([
    { $match: { softDeletedAt: null, projectId: { $in: projectIds } } },
    { $group: { _id: "$projectId", n: { $sum: 1 }, down: DOWN_COUNT } },
  ]);
  const map = new Map(counts.map((c) => [String(c._id), c]));

  // Owners + members for the page's projects (one query, grouped in memory).
  type Lite = { id: string; name: string; email: string; avatarUrl: string | null };
  const memberRows = await ProjectMember.find({ projectId: { $in: projectIds } })
    .populate("userId", "name email avatarUrl")
    .lean();
  const membersByProject = new Map<string, { owners: Lite[]; members: Lite[] }>();
  for (const row of memberRows) {
    const u = row.userId as unknown as { _id?: unknown; name?: string; email?: string; avatarUrl?: string | null } | null;
    if (!u?._id) continue; // user was deleted
    const lite: Lite = { id: String(u._id), name: u.name ?? "", email: u.email ?? "", avatarUrl: u.avatarUrl ?? null };
    const pid = String(row.projectId);
    const entry = membersByProject.get(pid) ?? { owners: [], members: [] };
    entry.members.push(lite);
    if (row.role === "owner") entry.owners.push(lite);
    membersByProject.set(pid, entry);
  }

  const data = projects.map((p) => {
    const c = map.get(String(p._id));
    const mem = membersByProject.get(String(p._id));
    return {
      ...serialize(p, c?.n ?? 0, c?.down ?? 0),
      owner: mem?.owners[0] ?? null, // primary owner
      members: mem?.members ?? [],
    };
  });
  res.json(paginate(data, total, page, limit));
}

/**
 * Users who may be @-mentioned in this project's maintenance notes: its members.
 * Access is gated to people who can see the project. Optional ?q= narrows.
 */
export async function getProjectMentionable(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  const allowed = await accessibleProjectIds(req.user!);
  if (allowed !== null && !allowed.some((p) => String(p) === projectId)) throw ApiError.forbidden("You don't have access to this project");

  const q = String((req.query.q as string) ?? "").trim().toLowerCase();
  const rows = await ProjectMember.find({ projectId }).populate("userId", "name email avatarUrl").lean();
  const users = rows
    .map((r) => r.userId as unknown as { _id?: unknown; name?: string; email?: string; avatarUrl?: string | null } | null)
    .filter((u): u is NonNullable<typeof u> => !!u?._id)
    .map((u) => ({ id: String(u._id), name: u.name ?? "", email: u.email ?? "", avatarUrl: u.avatarUrl ?? null }))
    .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    .slice(0, 10);
  res.json(users);
}

export async function getProject(req: Request, res: Response): Promise<void> {
  const project = await Project.findById(req.params.id).lean();
  if (!project) throw ApiError.notFound("Project not found");

  // Non-super-admins can only open projects they have access to (own / system /
  // one containing a monitor they can see). Don't leak existence otherwise.
  const allowedIds = await accessibleProjectIds(req.user!);
  if (allowedIds !== null && !allowedIds.some((pid) => String(pid) === String(project._id))) {
    throw ApiError.notFound("Project not found");
  }
  const [c] = await Monitor.aggregate<{ n: number; down: number }>([
    { $match: { softDeletedAt: null, projectId: project._id } },
    { $group: { _id: null, n: { $sum: 1 }, down: DOWN_COUNT } },
  ]);
  const myRole = await projectRole(req.user!, project._id);
  res.json({ ...serialize(project, c?.n ?? 0, c?.down ?? 0), myRole });
}

export async function createProject(req: Request, res: Response): Promise<void> {
  const { name, description } = req.body;
  if (await Project.findOne({ name })) throw ApiError.conflict("A project with that name already exists");
  const project = await Project.create({ name, description: description ?? "", createdBy: req.user!.id });
  // The creator is the project's first owner.
  await ProjectMember.create({ projectId: project._id, userId: req.user!.id, role: "owner" });
  await writeAudit(req, "project.create", { targetType: "project", targetId: project.id });
  res.status(201).json(serialize(project));
  publish("projects", "dashboard");
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
  publish("projects", "dashboard");
}

export async function deleteProject(req: Request, res: Response): Promise<void> {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound("Project not found");
  if (project.isSystem) throw ApiError.badRequest("The General project cannot be deleted");

  // Deleting a project deletes its monitors and all their data (checks,
  // incidents, uptime stats), plus its memberships and join requests.
  const monitorIds = (await Monitor.find({ projectId: project._id }).select("_id").lean()).map((m) => m._id);
  await purgeIncidentImagesFor(monitorIds); // delete incident-note images before removing the docs
  await Promise.all([
    Check.deleteMany({ monitorId: { $in: monitorIds } }),
    Incident.deleteMany({ monitorId: { $in: monitorIds } }),
    UptimeStat.deleteMany({ monitorId: { $in: monitorIds } }),
    ProjectMember.deleteMany({ projectId: project._id }),
    ProjectJoinRequest.deleteMany({ projectId: project._id }),
    DeployToken.deleteMany({ projectId: project._id }),
    // Maintenance windows (monitor- + project-scoped) and their S3 proof images.
    purgeMaintenanceFor({ monitorIds, projectIds: [project._id] }),
  ]);
  await Monitor.deleteMany({ projectId: project._id });
  await project.deleteOne();
  await writeAudit(req, "project.delete", { targetType: "project", targetId: project.id, metadata: { monitorsDeleted: monitorIds.length } });
  res.status(204).send();
  publish("projects", "dashboard", "monitors");
}
