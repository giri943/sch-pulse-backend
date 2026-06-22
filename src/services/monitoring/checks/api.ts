import { type CheckResult, type MonitorWithId } from "../types";
import { probe } from "../httpProbe";
import { classify } from "../classify";

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

/** HTTP check plus optional JSON body assertions, now challenge-aware + WAF-aware. */
export async function apiCheck(monitor: MonitorWithId): Promise<CheckResult> {
  const outcome = await probe(monitor.url, {
    method: monitor.method ?? "GET",
    headers: (monitor.headers as Record<string, string>) ?? undefined,
    body: monitor.body ?? undefined,
    timeoutMs: monitor.timeoutMs ?? 10000,
  });

  if (!outcome.response) {
    const c = classify({ errorCode: outcome.errorCode });
    return { up: c.up, responseTimeMs: outcome.responseTimeMs, error: c.reason, classification: c.classification, waf: c.waf };
  }

  const r = outcome.response;
  const assertions = (monitor.assertions as Assertion[] | undefined) ?? [];

  // Evaluate JSON assertions against the body sample (health payloads are small).
  // contentMatch feeds the classifier so a 2xx with wrong content is a real failure.
  let assertionFailure: string | null = null;
  let contentMatch: boolean | undefined;
  if (assertions.length) {
    try {
      assertionFailure = evaluate(JSON.parse(r.bodySample), assertions);
    } catch {
      assertionFailure = "Response was not valid JSON";
    }
    contentMatch = assertionFailure === null;
  }

  const c = classify({
    status: r.status,
    headers: r.headers,
    setCookies: r.setCookies,
    bodySample: r.bodySample,
    expectedStatus: monitor.expectedStatusCode ?? 200,
    contentMatch,
    redirected: r.redirected,
  });

  // If the firewall says "up" we trust it; otherwise an assertion failure on a 2xx
  // surfaces as the specific reason.
  const error = c.up ? null : (c.classification === "content_mismatch" && assertionFailure) || c.reason;
  return { up: c.up, statusCode: r.status, responseTimeMs: r.responseTimeMs, error, classification: c.classification, waf: c.waf };
}
