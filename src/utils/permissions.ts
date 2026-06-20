/**
 * Permission catalog (Strapi-style RBAC). Roles are data and hold a list of these
 * permission keys. `:own` vs `:all` controls data scope (own = created-by-me or
 * tagged-to-me; all = everything).
 */
export const PERMISSIONS = {
  MONITOR_CREATE: "monitor:create",
  MONITOR_READ_OWN: "monitor:read:own",
  MONITOR_READ_ALL: "monitor:read:all",
  MONITOR_UPDATE_OWN: "monitor:update:own",
  MONITOR_UPDATE_ALL: "monitor:update:all",
  MONITOR_DELETE_OWN: "monitor:delete:own",
  MONITOR_DELETE_ALL: "monitor:delete:all",
  MONITOR_RUN_OWN: "monitor:run:own",
  MONITOR_RUN_ALL: "monitor:run:all",

  INCIDENT_READ_OWN: "incident:read:own",
  INCIDENT_READ_ALL: "incident:read:all",
  INCIDENT_UPDATE_OWN: "incident:update:own",
  INCIDENT_UPDATE_ALL: "incident:update:all",

  USER_READ: "user:read",
  USER_CREATE: "user:create",
  USER_UPDATE: "user:update",
  USER_DISABLE: "user:disable",

  ROLE_READ: "role:read",
  ROLE_CREATE: "role:create",
  ROLE_UPDATE: "role:update",
  ROLE_DELETE: "role:delete",

  RULE_READ: "rule:read",
  RULE_MANAGE: "rule:manage",

  CHANNEL_READ: "channel:read",
  CHANNEL_MANAGE: "channel:manage",

  PROJECT_READ: "project:read",
  PROJECT_CREATE: "project:create",
  PROJECT_UPDATE: "project:update",
  PROJECT_DELETE: "project:delete",

  AUDIT_READ: "audit:read",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Grouped catalog used by the role-builder UI (Phase 2). */
export const PERMISSION_CATALOG: { resource: string; items: { key: Permission; label: string }[] }[] = [
  {
    resource: "Monitors",
    items: [
      { key: PERMISSIONS.MONITOR_CREATE, label: "Create monitors" },
      { key: PERMISSIONS.MONITOR_READ_OWN, label: "View own / tagged monitors" },
      { key: PERMISSIONS.MONITOR_READ_ALL, label: "View all monitors" },
      { key: PERMISSIONS.MONITOR_UPDATE_OWN, label: "Edit own / tagged monitors" },
      { key: PERMISSIONS.MONITOR_UPDATE_ALL, label: "Edit all monitors" },
      { key: PERMISSIONS.MONITOR_DELETE_OWN, label: "Delete own / tagged monitors" },
      { key: PERMISSIONS.MONITOR_DELETE_ALL, label: "Delete all monitors" },
      { key: PERMISSIONS.MONITOR_RUN_OWN, label: "Run / test own monitors" },
      { key: PERMISSIONS.MONITOR_RUN_ALL, label: "Run / test all monitors" },
    ],
  },
  {
    resource: "Incidents",
    items: [
      { key: PERMISSIONS.INCIDENT_READ_OWN, label: "View own incidents" },
      { key: PERMISSIONS.INCIDENT_READ_ALL, label: "View all incidents" },
      { key: PERMISSIONS.INCIDENT_UPDATE_OWN, label: "Resolve / annotate own incidents" },
      { key: PERMISSIONS.INCIDENT_UPDATE_ALL, label: "Resolve / annotate all incidents" },
    ],
  },
  {
    resource: "Users",
    items: [
      { key: PERMISSIONS.USER_READ, label: "View users" },
      { key: PERMISSIONS.USER_CREATE, label: "Create users" },
      { key: PERMISSIONS.USER_UPDATE, label: "Update users (role/status)" },
      { key: PERMISSIONS.USER_DISABLE, label: "Disable users" },
    ],
  },
  {
    resource: "Roles",
    items: [
      { key: PERMISSIONS.ROLE_READ, label: "View roles" },
      { key: PERMISSIONS.ROLE_CREATE, label: "Create roles" },
      { key: PERMISSIONS.ROLE_UPDATE, label: "Update roles" },
      { key: PERMISSIONS.ROLE_DELETE, label: "Delete roles" },
    ],
  },
  {
    resource: "Recommendation rules",
    items: [
      { key: PERMISSIONS.RULE_READ, label: "View rules" },
      { key: PERMISSIONS.RULE_MANAGE, label: "Manage rules" },
    ],
  },
  {
    resource: "Notification channels",
    items: [
      { key: PERMISSIONS.CHANNEL_READ, label: "View / tag channels" },
      { key: PERMISSIONS.CHANNEL_MANAGE, label: "Manage channels" },
    ],
  },
  {
    resource: "Projects",
    items: [
      { key: PERMISSIONS.PROJECT_READ, label: "View projects" },
      { key: PERMISSIONS.PROJECT_CREATE, label: "Create projects" },
      { key: PERMISSIONS.PROJECT_UPDATE, label: "Edit projects" },
      { key: PERMISSIONS.PROJECT_DELETE, label: "Delete projects" },
    ],
  },
  {
    resource: "Audit logs",
    items: [{ key: PERMISSIONS.AUDIT_READ, label: "View audit logs" }],
  },
];

/** Flat list of every permission — the Super Admin role gets all of these. */
export const ALL_PERMISSIONS: Permission[] = PERMISSION_CATALOG.flatMap((g) => g.items.map((i) => i.key));

/** Default permissions for the seeded "Member" role (self-service users). */
export const MEMBER_PERMISSIONS: Permission[] = [
  PERMISSIONS.MONITOR_CREATE,
  PERMISSIONS.MONITOR_READ_OWN,
  PERMISSIONS.MONITOR_UPDATE_OWN,
  PERMISSIONS.MONITOR_DELETE_OWN,
  PERMISSIONS.MONITOR_RUN_OWN,
  PERMISSIONS.INCIDENT_READ_OWN,
  PERMISSIONS.INCIDENT_UPDATE_OWN,
  PERMISSIONS.CHANNEL_READ,
  PERMISSIONS.PROJECT_READ,
  PERMISSIONS.PROJECT_CREATE,
];

/**
 * Wildcard permission — grants everything, including permissions added in the
 * future. Held only by the Super Admin system role. It is intentionally NOT in
 * the catalog, so it can never be granted to a custom role via the API/UI
 * (sanitize() drops anything not in ALL_PERMISSIONS).
 */
export const WILDCARD = "*";

export const isSuperAdmin = (perms: string[]): boolean => perms.includes(WILDCARD);

export const has = (perms: string[], key: Permission): boolean =>
  perms.includes(WILDCARD) || perms.includes(key);

/** Read scope for a resource: "all" beats "own". null = no access. */
export function readScope(perms: string[], resource: "monitor" | "incident"): "all" | "own" | null {
  if (perms.includes(WILDCARD) || perms.includes(`${resource}:read:all`)) return "all";
  if (perms.includes(`${resource}:read:own`)) return "own";
  return null;
}

/** Whether a write action is allowed given ownership. */
export function canWrite(
  perms: string[],
  resource: "monitor" | "incident",
  action: "update" | "delete" | "run",
  isOwner: boolean,
): boolean {
  if (perms.includes(WILDCARD) || perms.includes(`${resource}:${action}:all`)) return true;
  if (perms.includes(`${resource}:${action}:own`)) return isOwner;
  return false;
}
