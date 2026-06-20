import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Project } from "../models/project.model";
import { ProjectMember, PROJECT_ROLES, type ProjectRole } from "../models/projectMember.model";
import { ProjectJoinRequest } from "../models/projectJoinRequest.model";
import { User } from "../models/user.model";
import { ApiError } from "../utils/ApiError";
import { writeAudit } from "../utils/audit";
import { assertProjectOwner, projectRole } from "../utils/projectAccess";
import { sendEmail, projectJoinRequestEmail, projectJoinDecisionEmail } from "../services/mailer";

/** Emails of a project's owners (to notify on requests). */
async function ownerEmails(projectId: Types.ObjectId | string): Promise<string[]> {
  const owners = await ProjectMember.find({ projectId, role: "owner" }).select("userId").lean();
  if (!owners.length) return [];
  const users = await User.find({ _id: { $in: owners.map((o) => o.userId) } }).select("email").lean();
  return [...new Set(users.map((u) => u.email))];
}

async function userEmail(userId: Types.ObjectId | string): Promise<string[]> {
  const u = await User.findById(userId).select("email").lean();
  return u?.email ? [u.email] : [];
}

// ─── Discovery ───────────────────────────────────────────────
/** Projects the user can request to join (not already a member, not the system project). */
export async function discoverProjects(req: Request, res: Response): Promise<void> {
  const uid = req.user!.id;
  const q = String((req.query.q as string) ?? "").trim();
  const memberIds = (await ProjectMember.find({ userId: uid }).select("projectId").lean()).map((m) => m.projectId);

  const filter: Record<string, unknown> = { isSystem: false, _id: { $nin: memberIds } };
  if (q) filter.name = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const projects = await Project.find(filter).sort({ name: 1 }).limit(25).lean();

  const pending = await ProjectJoinRequest.find({
    userId: uid,
    status: "pending",
    projectId: { $in: projects.map((p) => p._id) },
  })
    .select("projectId")
    .lean();
  const pendingSet = new Set(pending.map((r) => String(r.projectId)));

  res.json(
    projects.map((p) => ({
      id: String(p._id),
      name: p.name,
      description: p.description ?? "",
      requested: pendingSet.has(String(p._id)),
    })),
  );
}

// ─── Join requests ───────────────────────────────────────────
export async function requestToJoin(req: Request, res: Response): Promise<void> {
  const uid = req.user!.id;
  const projectId = req.params.id;
  const project = await Project.findById(projectId).lean();
  if (!project) throw ApiError.notFound("Project not found");
  if (project.isSystem) throw ApiError.badRequest("This project is not join-requestable");

  if (await ProjectMember.findOne({ projectId, userId: uid })) {
    throw ApiError.badRequest("You're already a member of this project");
  }
  const existing = await ProjectJoinRequest.findOne({ projectId, userId: uid, status: "pending" });
  if (existing) throw ApiError.conflict("You already have a pending request for this project");

  const reqDoc = await ProjectJoinRequest.create({ projectId, userId: uid, message: req.body?.message ?? "" });
  await writeAudit(req, "project.join_request", { targetType: "project", targetId: String(projectId) });

  // Notify owners.
  const to = await ownerEmails(projectId);
  if (to.length) {
    void sendEmail(
      projectJoinRequestEmail({
        to,
        projectName: project.name,
        requesterName: req.user!.name,
        requesterEmail: req.user!.email,
        message: req.body?.message,
      }),
    );
  }
  res.status(201).json({ id: reqDoc.id, status: reqDoc.status });
}

/** Owner: pending requests for a project. */
export async function listProjectRequests(req: Request, res: Response): Promise<void> {
  await assertProjectOwner(req.user!, req.params.id);
  const requests = await ProjectJoinRequest.find({ projectId: req.params.id, status: "pending" })
    .populate<{ userId: { _id: unknown; name: string; email: string; avatarUrl?: string } }>("userId", "name email avatarUrl")
    .sort({ createdAt: -1 })
    .lean();
  res.json(
    requests.map((r) => ({
      id: String(r._id),
      message: r.message ?? "",
      createdAt: r.createdAt,
      user: r.userId
        ? { id: String(r.userId._id), name: r.userId.name, email: r.userId.email, avatarUrl: r.userId.avatarUrl ?? null }
        : null,
    })),
  );
}

/** The current user's pending requests (to show status / cancel). */
export async function myRequests(req: Request, res: Response): Promise<void> {
  const requests = await ProjectJoinRequest.find({ userId: req.user!.id, status: "pending" })
    .populate<{ projectId: { _id: unknown; name: string } }>("projectId", "name")
    .lean();
  res.json(
    requests.map((r) => ({
      id: String(r._id),
      project: r.projectId ? { id: String(r.projectId._id), name: r.projectId.name } : null,
      createdAt: r.createdAt,
    })),
  );
}

export async function acceptRequest(req: Request, res: Response): Promise<void> {
  const reqDoc = await ProjectJoinRequest.findById(req.params.id);
  if (!reqDoc || reqDoc.status !== "pending") throw ApiError.notFound("Request not found");
  await assertProjectOwner(req.user!, String(reqDoc.projectId));

  const role: ProjectRole = (PROJECT_ROLES as readonly string[]).includes(req.body?.role) ? req.body.role : "viewer";
  await ProjectMember.updateOne(
    { projectId: reqDoc.projectId, userId: reqDoc.userId },
    { $set: { role, addedBy: req.user!.id } },
    { upsert: true },
  );
  reqDoc.status = "accepted";
  reqDoc.decidedBy = req.user!.id as never;
  reqDoc.decidedAt = new Date();
  reqDoc.grantedRole = role;
  await reqDoc.save();
  await writeAudit(req, "project.join_accept", { targetType: "project", targetId: String(reqDoc.projectId) });

  const project = await Project.findById(reqDoc.projectId).select("name").lean();
  const to = await userEmail(String(reqDoc.userId));
  if (to.length && project) {
    void sendEmail(projectJoinDecisionEmail({ to, projectName: project.name, accepted: true, deciderName: req.user!.name, role }));
  }
  res.json({ id: reqDoc.id, status: reqDoc.status, role });
}

export async function rejectRequest(req: Request, res: Response): Promise<void> {
  const reqDoc = await ProjectJoinRequest.findById(req.params.id);
  if (!reqDoc || reqDoc.status !== "pending") throw ApiError.notFound("Request not found");
  await assertProjectOwner(req.user!, String(reqDoc.projectId));

  reqDoc.status = "rejected";
  reqDoc.decidedBy = req.user!.id as never;
  reqDoc.decidedAt = new Date();
  await reqDoc.save();
  await writeAudit(req, "project.join_reject", { targetType: "project", targetId: String(reqDoc.projectId) });

  const project = await Project.findById(reqDoc.projectId).select("name").lean();
  const to = await userEmail(String(reqDoc.userId));
  if (to.length && project) {
    void sendEmail(projectJoinDecisionEmail({ to, projectName: project.name, accepted: false, deciderName: req.user!.name }));
  }
  res.json({ id: reqDoc.id, status: reqDoc.status });
}

/** Requester cancels their own pending request. */
export async function cancelRequest(req: Request, res: Response): Promise<void> {
  const reqDoc = await ProjectJoinRequest.findById(req.params.id);
  if (!reqDoc || reqDoc.status !== "pending") throw ApiError.notFound("Request not found");
  if (String(reqDoc.userId) !== req.user!.id) throw ApiError.forbidden("Not your request");
  reqDoc.status = "cancelled";
  await reqDoc.save();
  res.json({ id: reqDoc.id, status: reqDoc.status });
}

// ─── Members ─────────────────────────────────────────────────
export async function listMembers(req: Request, res: Response): Promise<void> {
  // Must be a member of the project (or super admin) to view its members.
  if ((await projectRole(req.user!, req.params.id)) == null) throw ApiError.forbidden("You're not a member of this project");
  const members = await ProjectMember.find({ projectId: req.params.id })
    .populate<{ userId: { _id: unknown; name: string; email: string; avatarUrl?: string } }>("userId", "name email avatarUrl")
    .lean();
  res.json(
    members
      .filter((m) => m.userId)
      .map((m) => ({
        id: String(m._id),
        role: m.role,
        user: { id: String(m.userId._id), name: m.userId.name, email: m.userId.email, avatarUrl: m.userId.avatarUrl ?? null },
      })),
  );
}

/** Owner invites a user directly (no request needed). */
export async function addMember(req: Request, res: Response): Promise<void> {
  await assertProjectOwner(req.user!, req.params.id);
  const project = await Project.findById(req.params.id).select("name").lean();
  if (!project) throw ApiError.notFound("Project not found");
  const { userId } = req.body;
  if (!(await User.findById(userId))) throw ApiError.badRequest("Invalid user");
  const role: ProjectRole = (PROJECT_ROLES as readonly string[]).includes(req.body?.role) ? req.body.role : "viewer";

  await ProjectMember.updateOne(
    { projectId: req.params.id, userId },
    { $set: { role, addedBy: req.user!.id } },
    { upsert: true },
  );
  await writeAudit(req, "project.member_add", { targetType: "project", targetId: req.params.id });
  const to = await userEmail(userId);
  if (to.length) {
    void sendEmail(projectJoinDecisionEmail({ to, projectName: project.name, accepted: true, deciderName: req.user!.name, role }));
  }
  res.status(201).json({ ok: true });
}

export async function updateMemberRole(req: Request, res: Response): Promise<void> {
  await assertProjectOwner(req.user!, req.params.id);
  const role: ProjectRole = (PROJECT_ROLES as readonly string[]).includes(req.body?.role) ? req.body.role : "viewer";
  const member = await ProjectMember.findOne({ projectId: req.params.id, userId: req.params.userId });
  if (!member) throw ApiError.notFound("Member not found");

  // Don't allow demoting the last owner.
  if (member.role === "owner" && role !== "owner") {
    const owners = await ProjectMember.countDocuments({ projectId: req.params.id, role: "owner" });
    if (owners <= 1) throw ApiError.badRequest("A project must have at least one owner");
  }
  member.role = role;
  await member.save();
  await writeAudit(req, "project.member_role", { targetType: "project", targetId: req.params.id });
  res.json({ ok: true, role });
}

export async function removeMember(req: Request, res: Response): Promise<void> {
  await assertProjectOwner(req.user!, req.params.id);
  const member = await ProjectMember.findOne({ projectId: req.params.id, userId: req.params.userId });
  if (!member) throw ApiError.notFound("Member not found");
  if (member.role === "owner") {
    const owners = await ProjectMember.countDocuments({ projectId: req.params.id, role: "owner" });
    if (owners <= 1) throw ApiError.badRequest("A project must have at least one owner");
  }
  await member.deleteOne();
  await writeAudit(req, "project.member_remove", { targetType: "project", targetId: req.params.id });
  res.status(204).send();
}
