import { User } from "../models/user.model";
import { ProjectMember } from "../models/projectMember.model";

/**
 * Google Chat @mentions for a monitor's audience: the project owner(s) + the
 * monitor's tagged members. Only users who signed in with Google can be
 * @mentioned (we need their Google user id); email-only users are skipped.
 * Returns e.g. "<users/123> <users/456>" (empty string if none).
 */
export async function monitorChatMentions(monitor: { members?: unknown[]; projectId?: unknown }): Promise<string> {
  const ids = new Set<string>();
  if (monitor.projectId) {
    const owners = await ProjectMember.find({ projectId: monitor.projectId, role: "owner" }).select("userId").lean();
    owners.forEach((o) => ids.add(String(o.userId)));
  }
  ((monitor.members as unknown[] | undefined) ?? []).forEach((m) => ids.add(String(m)));
  if (!ids.size) return "";

  const users = await User.find({ _id: { $in: [...ids] }, googleId: { $ne: null } })
    .select("googleId")
    .lean();
  return [...new Set(users.map((u) => `<users/${u.googleId}>`))].join(" ");
}
