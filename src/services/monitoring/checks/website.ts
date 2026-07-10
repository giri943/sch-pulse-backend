import { type CheckResult, type MonitorWithId } from "../types";
import { probe } from "../httpProbe";
import { classify } from "../classify";

/**
 * Website check: a challenge-aware HTTP request judged by `classify()`, which is
 * WAF-aware — a firewall block/challenge means the site is UP, not down. Network/
 * timeout/DNS/TLS errors are returned as a (non-up) result, not thrown.
 */
export async function websiteCheck(monitor: MonitorWithId): Promise<CheckResult> {
  const outcome = await probe(monitor.url, {
    method: monitor.method ?? "GET",
    headers: (monitor.headers as Record<string, string>) ?? undefined,
    body: monitor.body ?? undefined,
    timeoutMs: monitor.timeoutMs ?? 10000,
  });

  if (!outcome.response) {
    const c = classify({ errorCode: outcome.errorCode });
    return {
      up: c.up,
      responseTimeMs: outcome.responseTimeMs,
      error: c.reason,
      classification: c.classification,
      waf: c.waf,
    };
  }

  const r = outcome.response;
  const c = classify({
    status: r.status,
    headers: r.headers,
    setCookies: r.setCookies,
    bodySample: r.bodySample,
    expectedStatus: monitor.expectedStatusCode ?? 200,
    redirected: r.redirected,
  });
  return {
    up: c.up,
    statusCode: r.status,
    responseTimeMs: r.responseTimeMs,
    error: c.up ? null : c.reason,
    classification: c.classification,
    waf: c.waf,
    server: r.headers.get("server") ?? undefined,
  };
}
