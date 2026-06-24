import { config } from "../config";

/**
 * Pulse is an org-only app — accounts must belong to the allowed email domain
 * (ALLOWED_EMAIL_DOMAIN, default schbang.com). Enforced on create, login, and
 * Google sign-in so no off-domain account can ever exist or authenticate.
 */
export function emailDomainAllowed(email: string): boolean {
  return (email.split("@")[1] ?? "").toLowerCase() === config.google.allowedDomain.toLowerCase();
}
