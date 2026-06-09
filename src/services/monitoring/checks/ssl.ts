import tls from "node:tls";
import { URL } from "node:url";
import type { CheckResult, MonitorWithId } from "../types";

/**
 * Open a TLS connection and read the peer certificate validity. "up" = cert is
 * currently valid (not expired, chain verified). Returns expiry so the engine
 * can emit 30/15/7-day warnings.
 */
export async function sslCheck(monitor: MonitorWithId): Promise<CheckResult> {
  const start = Date.now();
  let host: string;
  let port = 443;
  try {
    const u = new URL(monitor.url);
    host = u.hostname;
    if (u.port) port = Number(u.port);
  } catch {
    return { up: false, responseTimeMs: 0, error: "Invalid URL" };
  }

  return new Promise<CheckResult>((resolve) => {
    const timeoutMs = monitor.timeoutMs ?? 10000;
    const socket = tls.connect(
      { host, port, servername: host, timeout: timeoutMs, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const responseTimeMs = Date.now() - start;
        if (!cert || !cert.valid_to) {
          socket.end();
          return resolve({ up: false, responseTimeMs, error: "No certificate presented" });
        }
        const expiresAt = new Date(cert.valid_to);
        const expired = expiresAt.getTime() <= Date.now();
        const authorized = socket.authorized;
        socket.end();
        resolve({
          up: !expired && authorized,
          responseTimeMs,
          sslExpiresAt: expiresAt,
          error: expired
            ? "certificate has expired"
            : authorized
              ? null
              : `certificate not authorized: ${socket.authorizationError ?? "unknown"}`,
        });
      },
    );
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ up: false, responseTimeMs: Date.now() - start, error: "TLS handshake timed out" });
    });
    socket.on("error", (err) => {
      resolve({
        up: false,
        responseTimeMs: Date.now() - start,
        error: (err as { code?: string }).code ?? err.message,
      });
    });
  });
}
