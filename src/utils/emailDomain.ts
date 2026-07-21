import { config } from "../config";

/**
 * Pulse is an org-only app — accounts must belong to the allowed email domain
 * (ALLOWED_EMAIL_DOMAIN, default schbang.com). Enforced on create, login, and
 * Google sign-in so no off-domain account can ever exist or authenticate.
 * In DEV the restriction is lifted so any test account can be used locally.
 */
export function emailDomainAllowed(email: string): boolean {
  if (!config.isProd) return true; // dev-only: allow any account for testing
  return (email.split("@")[1] ?? "").toLowerCase() === config.google.allowedDomain.toLowerCase();
}
