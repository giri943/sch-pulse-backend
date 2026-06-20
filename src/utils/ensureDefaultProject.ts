import { Project, GENERAL_PROJECT } from "../models/project.model";
import { Monitor } from "../models/monitor.model";
import { ProjectMember } from "../models/projectMember.model";
import { logger } from "../config/logger";

/**
 * Ensure the seeded "General" project exists and back-fill any monitor that has
 * no project into it. Runs on boot so existing deployments migrate with zero
 * downtime when projects become required.
 */
export async function ensureDefaultProject(): Promise<void> {
  await Project.updateOne(
    { name: GENERAL_PROJECT },
    { $setOnInsert: { description: "Default project for ungrouped monitors", isSystem: true } },
    { upsert: true },
  );
  const general = await Project.findOne({ name: GENERAL_PROJECT }).select("_id").lean();
  if (!general) return;

  const res = await Monitor.updateMany(
    { $or: [{ projectId: { $exists: false } }, { projectId: null }] },
    { projectId: general._id },
  );
  if (res.modifiedCount) {
    logger.info(`Backfilled ${res.modifiedCount} monitor(s) into the "${GENERAL_PROJECT}" project`);
  }

  // Make each project's creator an owner (idempotent) so existing projects have an owner.
  const owned = await Project.find({ createdBy: { $ne: null } }).select("_id createdBy").lean();
  for (const p of owned) {
    await ProjectMember.updateOne(
      { projectId: p._id, userId: p.createdBy },
      { $setOnInsert: { role: "owner" } },
      { upsert: true },
    );
  }
}
