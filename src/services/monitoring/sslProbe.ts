import tls from "node:tls";
import { URL } from "node:url";
import { safeResolve } from "../../utils/ssrfGuard";

/**
 * Best-effort TLS certificate expiry probe for any https URL. Used to auto-track
 * SSL on website/api monitors (not just dedicated SSL monitors). Returns null on
 * any failure (http url, handshake error, timeout) — never throws.
 */
export async function probeSslExpiry(rawUrl: string, timeoutMs = 8000): Promise<Date | null> {
  let host: string;
  let port = 443;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return null;
    host = u.hostname;
    if (u.port) port = Number(u.port);
  } catch {
    return null;
  }

  // SSRF guard: resolve to a public IP and connect to THAT (with the hostname as
  // SNI) so the probe can't be pointed at an internal service. null = blocked.
  const pinnedIp = await safeResolve(host);
  if (!pinnedIp) return null;

  return new Promise<Date | null>((resolve) => {
    let settled = false;
    const done = (v: Date | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const socket = tls.connect(
      { host: pinnedIp, port, servername: host, timeout: timeoutMs, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const expiry = cert?.valid_to ? new Date(cert.valid_to) : null;
        socket.end();
        done(expiry && !Number.isNaN(expiry.getTime()) ? expiry : null);
      },
    );
    socket.on("timeout", () => {
      socket.destroy();
      done(null);
    });
    socket.on("error", () => done(null));
  });
}
