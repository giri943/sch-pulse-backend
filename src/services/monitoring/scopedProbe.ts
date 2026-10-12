import { Monitor } from "../../models/monitor.model";
import { logger } from "../../config/logger";
import { probeSslExpiry } from "./sslProbe";
import { probeDomainExpiry } from "./domainProbe";

/**
 * Immediately refresh an SSL-only / Domain-only monitor's expiry + status.
 * These scopes are excluded from the 20s uptime cron (no uptime checks), so
 * this powers on-demand "Run now" and the first check right after creation —
 * otherwise they'd sit blank until the next hourly lifecycle pass. Full monitors
 * are handled by the health-check cron and are a no-op here. Never throws.
 */
export async function refreshScopedMonitor(monitorId: unknown): Promise<void> {
  try {
    const m = await Monitor.findById(monitorId).select("monitoringScope url timeoutMs").lean();
    if (!m) return;
    const scope = (m as { monitoringScope?: string }).monitoringScope ?? "full";
    const url = (m as { url: string }).url;
    const timeoutMs = (m as { timeoutMs?: number }).timeoutMs ?? 10000;
    const now = new Date();

    if (scope === "ssl") {
      const expiry = await probeSslExpiry(url, timeoutMs);
      await Monitor.updateOne(
        { _id: monitorId },
        expiry
          ? { lastCheckedAt: now, sslExpiresAt: expiry, status: expiry.getTime() <= now.getTime() ? "down" : "operational" }
          : { lastCheckedAt: now, status: "unknown" },
      );
      logger.info({ monitorId: String(monitorId), expiry }, "SSL-only monitor refreshed");
    } else if (scope === "domain") {
      const res = await probeDomainExpiry(url, timeoutMs);
      // A throttled probe leaves domainCheckedAt alone so the lifecycle pass retries it.
      const patch = res.ok
        ? { lastCheckedAt: now, domainCheckedAt: now, domainExpiresAt: res.expiresAt, status: res.expiresAt.getTime() <= now.getTime() ? "down" : "operational" }
        : res.reason === "rate_limited"
          ? { lastCheckedAt: now }
          : { lastCheckedAt: now, domainCheckedAt: now };
      await Monitor.updateOne({ _id: monitorId }, patch);
      logger.info(
        { monitorId: String(monitorId), ...(res.ok ? { expiry: res.expiresAt } : { reason: res.reason }) },
        "Domain-only monitor refreshed",
      );
    }
  } catch (err) {
    logger.error({ err, monitorId: String(monitorId) }, "Scoped monitor refresh failed");
  }
}
