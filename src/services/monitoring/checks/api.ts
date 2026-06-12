import { type CheckResult, type MonitorWithId, normalizeError } from "../types";

interface Assertion {
  jsonPath: string;
  operator: "equals" | "exists" | "contains";
  value?: string;
}

function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function evaluate(body: unknown, assertions: Assertion[]): string | null {
  for (const a of assertions) {
    const actual = readPath(body, a.jsonPath);
    if (a.operator === "exists" && actual === undefined) return `Missing ${a.jsonPath}`;
    if (a.operator === "equals" && String(actual) !== String(a.value))
      return `${a.jsonPath} expected ${a.value}, got ${String(actual)}`;
    if (a.operator === "contains" && !String(actual ?? "").includes(a.value ?? ""))
      return `${a.jsonPath} does not contain ${a.value}`;
  }
  return null;
}

/** HTTP check plus optional JSON body assertions. */
export async function apiCheck(monitor: MonitorWithId): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), monitor.timeoutMs ?? 10000);

  try {
    const method = monitor.method ?? "GET";
    const res = await fetch(monitor.url, {
      method,
      // Default UA/Accept so CDN/bot filters (e.g. Cloudflare) respond as they do
      // to Postman/browsers; the monitor's own headers override these.
      headers: {
        "User-Agent": "SchbangPulse/1.0 (+uptime-monitor)",
        Accept: "*/*",
        ...((monitor.headers as Record<string, string>) ?? {}),
      },
      body: method !== "GET" && method !== "HEAD" ? (monitor.body ?? undefined) : undefined,
      signal: controller.signal,
    });
    const responseTimeMs = Date.now() - start;
    const expected = monitor.expectedStatusCode ?? 200;
    // Match the website check: when expected is left at the default 200, treat
    // any 2xx as healthy (e.g. a /_health endpoint returning 204). A specific
    // non-200 expected (e.g. 204, 301) is still matched exactly.
    let up = res.status === expected || (expected === 200 && res.status >= 200 && res.status < 300);
    let error: string | null = up ? null : `Unexpected status ${res.status}`;

    const assertions = (monitor.assertions as Assertion[] | undefined) ?? [];
    if (up && assertions.length) {
      try {
        const failure = evaluate(await res.json(), assertions);
        if (failure) {
          up = false;
          error = failure;
        }
      } catch {
        up = false;
        error = "Response was not valid JSON";
      }
    }
    return { up, statusCode: res.status, responseTimeMs, error };
  } catch (err) {
    return { up: false, responseTimeMs: Date.now() - start, error: normalizeError(err) };
  } finally {
    clearTimeout(timer);
  }
}
