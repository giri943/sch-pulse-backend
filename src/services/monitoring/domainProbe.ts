import { logger } from "../../config/logger";

// Common two-level public suffixes so we resolve the registrable (apex) domain
// correctly, e.g. api.example.co.in → example.co.in (not co.in).
const TWO_LEVEL_TLDS = new Set([
  "co.in", "net.in", "org.in", "co.uk", "org.uk", "me.uk", "com.au", "net.au",
  "co.nz", "co.jp", "com.br", "com.sg", "co.za", "com.cn", "co.id", "com.mx",
]);

// rdap.org sits behind Cloudflare, which returns 403 to requests with no
// User-Agent. Node's fetch sends none by default, so this header is required.
const RDAP_USER_AGENT = "SchbangPulse/1.0 (+uptime-monitor; https://pulse.letschbang.com)";

export type DomainProbeFailure = "rate_limited" | "blocked" | "not_found" | "error";

export type DomainProbeResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: DomainProbeFailure };

/** Best-effort registrable (apex) domain from a hostname. */
export function registrableDomain(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return TWO_LEVEL_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/** Apex domain for a monitor URL, or null if it has no usable hostname. */
export function apexOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host)) return null; // skip IPs
  return registrableDomain(host);
}

/**
 * Look up a domain's registration expiry via RDAP. Returns a tagged result so
 * callers can tell a throttle (retry soon) from a hard failure (back off).
 */
export async function probeDomainExpiry(url: string, timeoutMs = 8000): Promise<DomainProbeResult> {
  const domain = apexOf(url);
  if (!domain) return { ok: false, reason: "error" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json", "User-Agent": RDAP_USER_AGENT },
      signal: controller.signal,
    });

    if (res.status === 429) {
      logger.warn({ domain }, "Domain RDAP probe rate-limited (429)");
      return { ok: false, reason: "rate_limited" };
    }
    if (res.status === 403) {
      logger.warn({ domain }, "Domain RDAP probe blocked (403) - User-Agent may be rejected");
      return { ok: false, reason: "blocked" };
    }
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (!res.ok) {
      logger.warn({ domain, status: res.status }, "Domain RDAP probe failed");
      return { ok: false, reason: "error" };
    }

    const data = (await res.json()) as { events?: { eventAction?: string; eventDate?: string }[] };
    const exp = data.events?.find((e) => e.eventAction === "expiration")?.eventDate;
    if (!exp) {
      logger.debug({ domain }, "Domain RDAP response has no expiration event");
      return { ok: false, reason: "not_found" };
    }
    const date = new Date(exp);
    if (isNaN(date.getTime())) return { ok: false, reason: "not_found" };
    return { ok: true, expiresAt: date };
  } catch (err) {
    logger.debug({ err, domain }, "Domain RDAP probe errored");
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}
