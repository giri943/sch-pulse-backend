import { type CheckResult, type MonitorWithId, normalizeError } from "../types";

/**
 * HTTP request judged by status code + latency. Network/timeout errors are
 * returned as a DOWN result (not thrown) — they're valid outcomes.
 */
export async function websiteCheck(monitor: MonitorWithId): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), monitor.timeoutMs ?? 10000);

  try {
    const method = monitor.method ?? "GET";
    const res = await fetch(monitor.url, {
      method,
      headers: (monitor.headers as Record<string, string>) ?? undefined,
      body: method !== "GET" && method !== "HEAD" ? (monitor.body ?? undefined) : undefined,
      signal: controller.signal,
      redirect: "follow",
    });
    const responseTimeMs = Date.now() - start;
    const expected = monitor.expectedStatusCode ?? 200;
    const up = res.status === expected || (expected === 200 && res.status >= 200 && res.status < 300);
    return { up, statusCode: res.status, responseTimeMs, error: up ? null : `Unexpected status ${res.status}` };
  } catch (err) {
    return { up: false, responseTimeMs: Date.now() - start, error: normalizeError(err) };
  } finally {
    clearTimeout(timer);
  }
}
