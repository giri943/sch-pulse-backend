import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { config } from "../config";

/**
 * SSRF protection for the monitoring probes. The app fetches user-supplied URLs
 * server-side, so without this an authenticated user could point a monitor at
 * internal services or the cloud metadata endpoint (169.254.169.254) and read
 * IAM credentials. These helpers reject private/loopback/link-local/metadata
 * targets before any connection is made.
 *
 * Note: validation is done by resolving the hostname; there is a narrow
 * DNS-rebinding (TOCTOU) window between this check and the actual connect. It
 * blocks the realistic threat (direct internal/redirect-to-internal access).
 * Set ALLOW_PRIVATE_MONITOR_TARGETS=true to disable for trusted internal use.
 */

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (test)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18.0.0/15
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true; // loopback / unspecified
  if (/^fe[89ab]/.test(v)) return true; // link-local fe80::/10
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local fc00::/7
  if (v.startsWith("ff")) return true; // multicast
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/** True if an IP literal is private/loopback/link-local/reserved (or not an IP). */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not a valid IP → block defensively
}

/**
 * Resolve a hostname to a public IP to connect to, or null if it's blocked or
 * unresolvable. The returned IP can be used to "pin" the connection (e.g. as the
 * TLS host with the original hostname as SNI).
 */
export async function safeResolve(host: string): Promise<string | null> {
  if (isIP(host)) {
    if (config.allowPrivateMonitorTargets) return host;
    return isBlockedAddress(host) ? null : host;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return null;
  }
  if (!addrs.length) return null;
  if (config.allowPrivateMonitorTargets) return addrs[0].address;
  // Block if ANY resolved address is private (defends against split-horizon DNS).
  if (addrs.some((a) => isBlockedAddress(a.address))) return null;
  return addrs[0].address;
}

/** Throw unless `rawUrl` is an http(s) URL resolving only to public addresses. */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${u.protocol}`);
  }
  if (config.allowPrivateMonitorTargets) return;
  const resolved = await safeResolve(u.hostname);
  if (!resolved) throw new Error("Blocked: target resolves to a non-public address");
}
