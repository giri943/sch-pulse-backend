import { Role, SUPER_ADMIN_ROLE, MEMBER_ROLE } from "../models/role.model";
import { WILDCARD, MEMBER_PERMISSIONS } from "./permissions";
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
