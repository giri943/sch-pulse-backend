/**
 * Challenge-aware HTTP probe shared by the website and API checks.
 *
 * Why this exists: Node's built-in `fetch` (undici) does NOT carry cookies
 * across redirects and presents as an obvious bot. Many WAFs (notably F5
 * BIG-IP) gate the first contact with a cookie/redirect challenge — they issue
 * a `TS…` cookie on a 3xx and expect the client to come back carrying it. A
 * plain `fetch` never replays the cookie, so it loops or stalls and the monitor
 * records a false "down".
 *
 * This probe behaves like a browser: a realistic User-Agent, a manual redirect
 * loop, and a per-request cookie jar so challenge cookies are replayed on the
 * next hop. It returns the raw signals (status, headers, set-cookies, a body
 * sample) for `classify()` to judge — it does not decide up/down itself.
 */

import { normalizeError } from "./types";
import { assertPublicUrl } from "../../utils/ssrfGuard";

/** Bytes of body to read for WAF/content fingerprinting. Enough for block pages. */
const BODY_SAMPLE_BYTES = 16 * 1024;
/** Max redirects to follow manually (browser default is ~20; WAFs rarely exceed 2-3). */
const MAX_REDIRECTS = 5;
/**
 * Floor for the per-hop timeout. WAF challenges (e.g. F5 first-contact) can hold
 * a response for ~15-20s; a healthy site still returns in well under a second, so
 * this ceiling only ever bites on genuinely slow/challenged/dead targets.
 */
const CHALLENGE_BUDGET_MS = 30_000;

/** Browser-like defaults so simple UA filters and JS-less challenges treat us as a client. */
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 SchbangPulse/1.0 (+uptime-monitor)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface ProbeResponse {
  status: number;
  headers: Headers;
  setCookies: string[];
  bodySample: string;
  /** Latency of the final hop's response (ms). */
  responseTimeMs: number;
  /** True if more than one hop (redirect) was followed. */
  redirected: boolean;
}

export interface ProbeOutcome {
  response?: ProbeResponse;
  /** Normalized error code/message when no response was obtained. */
  errorCode?: string;
  /** Total wall-clock of the probe (ms), across all hops. */
  responseTimeMs: number;
}

export interface ProbeOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  /** Whether to read the body sample (skip for HEAD or pure status checks). */
  readBody?: boolean;
  /** Retries on a transient connection/timeout error (no HTTP response). Default 1. */
  retries?: number;
}

/** Wait `ms`, then resolve. Used for the brief back-off between probe retries. */
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Parse a single Set-Cookie line into [name, value]; null if unparseable. */
function parseCookie(line: string): [string, string] | null {
  const pair = line.split(";")[0];
  const idx = pair.indexOf("=");
  if (idx <= 0) return null;
  return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()];
}

/** Read up to BODY_SAMPLE_BYTES of the response body without buffering it all. */
async function readBodySample(res: Response): Promise<string> {
  if (!res.body) {
    try {
      return (await res.text()).slice(0, BODY_SAMPLE_BYTES);
    } catch {
      return "";
    }
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < BODY_SAMPLE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    /* truncated/aborted bodies are fine — we only need a sample */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return out.slice(0, BODY_SAMPLE_BYTES);
}

/**
 * Probe a URL, retrying once on a transient connection/timeout error. Sites
 * behind a tight WAF intermittently stall or drop the monitor's connection
 * (while real browsers pass) — a quick retry absorbs that blip so we don't raise
 * a false "down". A real HTTP response (even a WAF block page) is conclusive and
 * is never retried; only a no-response error is.
 */
export async function probe(url: string, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const retries = Math.max(0, opts.retries ?? 1);
  let outcome: ProbeOutcome = { errorCode: "Not attempted", responseTimeMs: 0 };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await delay(1000); // brief back-off before retrying
    outcome = await attemptProbe(url, opts);
    if (outcome.response) return outcome; // got a response → conclusive
  }
  return outcome; // exhausted retries — return the last transient error
}

/**
 * Fetch a URL like a browser: follow redirects manually while carrying cookies,
 * so WAF challenge cookies (e.g. F5 `TS…`) are replayed on the next hop.
 */
async function attemptProbe(url: string, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const method = opts.method ?? "GET";
  const perHopTimeout = Math.max(opts.timeoutMs ?? 10_000, CHALLENGE_BUDGET_MS);
  const headers = { ...DEFAULT_HEADERS, ...(opts.headers ?? {}) };
  const jar = new Map<string, string>();
  const started = Date.now();

  let current = url;
  let redirected = false;
  // Accumulate Set-Cookie across ALL hops so WAF challenge cookies issued on a
  // redirect (e.g. F5's `TS…` before a 307→/en) are still visible to classify().
  const allSetCookies: string[] = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perHopTimeout);
    const hopStart = Date.now();
    try {
      // SSRF guard: re-validate every hop so a redirect can't reach an internal
      // host or the cloud metadata endpoint. Throws → treated as a probe error.
      await assertPublicUrl(current);
      const cookieHeader = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(current, {
        method,
        headers: { ...headers, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
        body: method !== "GET" && method !== "HEAD" ? (opts.body ?? undefined) : undefined,
        redirect: "manual",
        signal: controller.signal,
      });

      // Accumulate cookies from this hop into the jar (browser behaviour).
      const setCookies = res.headers.getSetCookie?.() ?? [];
      allSetCookies.push(...setCookies);
      for (const line of setCookies) {
        const parsed = parseCookie(line);
        if (parsed) jar.set(parsed[0], parsed[1]);
      }

      // Follow redirects manually so the jar is replayed on the next hop.
      const location = res.headers.get("location");
      const isRedirect = res.status >= 300 && res.status < 400 && !!location;
      if (isRedirect && hop < MAX_REDIRECTS) {
        redirected = true;
        current = new URL(location, current).toString();
        // Drain the redirect body so the connection can be reused.
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        continue;
      }

      const bodySample = opts.readBody !== false && method !== "HEAD" ? await readBodySample(res) : "";
      return {
        response: {
          status: res.status,
          headers: res.headers,
          setCookies: allSetCookies,
          bodySample,
          responseTimeMs: Date.now() - hopStart,
          redirected,
        },
        responseTimeMs: Date.now() - started,
      };
    } catch (err) {
      return { errorCode: normalizeError(err), responseTimeMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  // Exhausted the redirect budget.
  return { errorCode: "Too many redirects", responseTimeMs: Date.now() - started };
}
