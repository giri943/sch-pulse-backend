import { logger } from "../../config/logger";

// Common two-level public suffixes so we resolve the registrable (apex) domain
// correctly, e.g. api.example.co.in → example.co.in (not co.in).
const TWO_LEVEL_TLDS = new Set([
  "co.in", "net.in", "org.in", "co.uk", "org.uk", "me.uk", "com.au", "net.au",
  "co.nz", "co.jp", "com.br", "com.sg", "co.za", "com.cn", "co.id", "com.mx",
]);

/** Best-effort registrable (apex) domain from a hostname. */
function registrableDomain(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return TWO_LEVEL_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/**
 * Look up a domain's registration expiry via RDAP (rdap.org routes to the right
 * registry). HTTPS + structured JSON, so it works where raw WHOIS (port 43) is
 * blocked. Returns null when it can't be determined (no false alarms).
 */
export async function probeDomainExpiry(url: string, timeoutMs = 8000): Promise<Date | null> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host)) return null; // skip IPs

  const domain = registrableDomain(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { events?: { eventAction?: string; eventDate?: string }[] };
    const exp = data.events?.find((e) => e.eventAction === "expiration")?.eventDate;
    if (!exp) return null;
    const date = new Date(exp);
    return isNaN(date.getTime()) ? null : date;
  } catch (err) {
    logger.debug({ err, domain }, "Domain RDAP probe failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
