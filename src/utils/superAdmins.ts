import { config } from "../config";

/**
 * Emails always granted the Super Admin role — on boot (existing users are
 * upgraded) and on first Google sign-in (new users are provisioned as admin).
 * The built-in list can be extended via the SUPER_ADMIN_EMAILS env var.
 */
const DEFAULT_SUPER_ADMINS = [
  "girish.soman@schbang.com",
  "arju.moon@schbang.com",
  "sk@schbang.com",
  "nikhil.mishra@schbang.com",
  "sameer.jawaharani@schbang.com",
  "shresht.poddar@schbang.com",
];

/** Lowercased set of bootstrap super-admin emails (built-in + env). */
export const SUPER_ADMIN_EMAILS = new Set(
  [...DEFAULT_SUPER_ADMINS, ...config.superAdminEmails].map((e) => e.toLowerCase()),
);

export function isBootstrapSuperAdmin(email?: string | null): boolean {
  return !!email && SUPER_ADMIN_EMAILS.has(email.toLowerCase());
}
