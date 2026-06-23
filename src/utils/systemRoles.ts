import { Role, SUPER_ADMIN_ROLE, MEMBER_ROLE } from "../models/role.model";
import { User } from "../models/user.model";
import { WILDCARD, MEMBER_PERMISSIONS } from "./permissions";
import { SUPER_ADMIN_EMAILS } from "./superAdmins";
import { logger } from "../config/logger";

/**
 * Ensure the system roles exist and are canonical. Runs on boot so deployments
 * self-heal: the Super Admin role is always pinned to the wildcard permission
 * (so it keeps full access as new permissions are added), and the Member role
 * is created with its defaults if missing. Safe to run repeatedly.
 */
export async function ensureSystemRoles(): Promise<void> {
  await Role.updateOne(
    { name: SUPER_ADMIN_ROLE },
    { $set: { permissions: [WILDCARD], isSystem: true }, $setOnInsert: { description: "Full access to everything" } },
    { upsert: true },
  );
  await Role.updateOne(
    { name: MEMBER_ROLE },
    {
      $set: { isSystem: true },
      $setOnInsert: {
        permissions: MEMBER_PERMISSIONS,
        description: "Create & manage own / tagged monitors",
      },
    },
    { upsert: true },
  );
  logger.info("System roles ensured (Super Admin = wildcard, Member = defaults)");
}

/**
 * Grant the Super Admin role to the configured bootstrap emails. Upgrades any
 * existing users with those emails; never downgrades anyone. New users with these
 * emails are provisioned as Super Admin on first sign-in (see Auth.controller).
 * Safe to run repeatedly. Applies on the user's next request (role is read per-request).
 */
export async function ensureSuperAdmins(): Promise<void> {
  if (!SUPER_ADMIN_EMAILS.size) return;
  const role = await Role.findOne({ name: SUPER_ADMIN_ROLE }).select("_id").lean();
  if (!role) return;
  const res = await User.updateMany(
    { email: { $in: [...SUPER_ADMIN_EMAILS] }, role: { $ne: role._id } },
    { $set: { role: role._id } },
  );
  if (res.modifiedCount) logger.info({ upgraded: res.modifiedCount }, "Bootstrap super admins ensured");
}
