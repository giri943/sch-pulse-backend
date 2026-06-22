/**
 * WAF-aware classification of a check outcome.
 *
 * The core insight: when a Web Application Firewall (Cloudflare, Akamai, F5,
 * Imperva, AWS WAF, Sucuri…) turns our monitor away, the *site is up* — for the
 * firewall to bounce us, the origin has to exist and be reachable. A genuinely
 * down site returns nothing, a connection error, or a 5xx. So we recognize the
 * block/challenge and classify it as "up" instead of raising a false "down".
 *
 * This module is a PURE function over an already-collected outcome — it does no
 * I/O, so it's trivially testable. The probes (website/api checks) collect the
 * raw signals and call `classify()`.
 */

export type Classification =
  | "up" //               Healthy: expected status (+ content match).
  | "up_blocked" //       WAF returned a block page (403/429/200-block). Site is alive.
  | "up_challenged" //    WAF challenge (JS/slow/interstitial). Site is alive.
  | "content_mismatch" // 2xx but a required keyword/assertion was missing.
  | "down_origin" //      Origin failure: 5xx, Cloudflare 520-527, or unexpected status.
  | "down_network" //     Connection refused/reset/unreachable.
  | "dns_failed" //       DNS did not resolve.
  | "tls_failed" //       Certificate/TLS handshake problem.
  | "timeout"; //         Timed out even after the challenge-aware retry (ambiguous → treated as down).

export type WafVendor = "cloudflare" | "akamai" | "f5-bigip" | "imperva" | "aws-waf" | "sucuri";

export interface ClassifyInput {
  /** HTTP status, if a response was received. */
  status?: number;
  /** Response headers (fetch Headers), if a response was received. */
  headers?: Headers;
  /** Set-Cookie values (fetch doesn't fold these into headers.get reliably). */
  setCookies?: string[];
  /** First few KB of the response body, lowercased by the caller is NOT required. */
  bodySample?: string;
  /** Normalized error code/message when the request threw (no response). */
  errorCode?: string | null;
  /** The status the monitor expects (default 200). */
  expectedStatus?: number;
  /**
   * Result of any content assertion/keyword check the probe ran:
   *  - true  → content matched
   *  - false → content did NOT match
   *  - undefined → no content check configured
   */
  contentMatch?: boolean;
  /** Whether the probe followed one or more redirects to reach the final response. */
  redirected?: boolean;
}

export interface ClassifyOutput {
  classification: Classification;
  /** Final up/down verdict the incident engine should act on. */
  up: boolean;
  /** Which WAF was detected (if any) — drives the "how to allow us" UI. */
  waf: WafVendor | null;
  /** Short human-readable explanation for the UI / incident trigger. */
  reason: string;
}

/** Classifications that mean "the site is actually serving" — no incident. */
const UP_CLASSES: ReadonlySet<Classification> = new Set(["up", "up_blocked", "up_challenged"]);

export function isUpClassification(c: Classification): boolean {
  return UP_CLASSES.has(c);
}

/** True when the site is up but a firewall is interfering with our checks. */
export function isWafInterference(c: Classification): boolean {
  return c === "up_blocked" || c === "up_challenged";
}

// ─────────────────────────────────────────────────────────────────────────────
// WAF fingerprinting
// ─────────────────────────────────────────────────────────────────────────────

interface Detection {
  vendor: WafVendor;
  /** "challenge" = interstitial/JS/slow gate; "block" = hard deny page. */
  kind: "challenge" | "block" | "ambiguous";
}

/** Lowercase a header value safely. */
function h(headers: Headers | undefined, name: string): string {
  return (headers?.get(name) ?? "").toLowerCase();
}

/** True when a header is present (non-empty). Safe when headers is undefined. */
function has(headers: Headers | undefined, name: string): boolean {
  return !!headers?.get(name);
}

/**
 * Identify the WAF (if any) and whether this looks like a challenge or a block.
 * Returns null when no firewall fingerprint is present.
 */
function detectWaf(input: ClassifyInput): Detection | null {
  const { status, headers, setCookies = [], bodySample = "", redirected = false } = input;
  const body = bodySample.toLowerCase();
  const cookies = setCookies.join("; ").toLowerCase();
  const server = h(headers, "server");

  // ── Cloudflare ──
  const cfRay = !!headers?.get("cf-ray");
  const cfMitigated = h(headers, "cf-mitigated");
  if (cfRay || server.includes("cloudflare") || cfMitigated) {
    // 520-527 are Cloudflare's "I can't reach your origin" range → genuine origin trouble,
    // handled by the status logic below (not a block). Here we only flag block/challenge.
    if (
      cfMitigated.includes("challenge") ||
      body.includes("just a moment") ||
      body.includes("checking your browser") ||
      body.includes("cf-browser-verification") ||
      body.includes("/cdn-cgi/challenge-platform")
    ) {
      return { vendor: "cloudflare", kind: "challenge" };
    }
    if (status === 403 || status === 429 || body.includes("attention required") || body.includes("error 1020")) {
      return { vendor: "cloudflare", kind: "block" };
    }
    // NB: a plain 5xx through Cloudflare (no interstitial body) is an ORIGIN error,
    // not a challenge — it's left for the 5xx guard in classify() to mark down.
  }

  // ── F5 BIG-IP ASM ── (the "TSxxxxxxxx" cookie, or BIGipServer pool cookie)
  if (/(^|[;\s])ts[0-9a-f]{6,}=/.test(cookies) || cookies.includes("bigipserver") || cookies.includes("f5_")) {
    if (body.includes("the requested url was rejected")) return { vendor: "f5-bigip", kind: "block" };
    if (status === 403 || status === 429) return { vendor: "f5-bigip", kind: "block" };
    // A challenge is the redirect/interstitial that issued the TS cookie (final status
    // < 500). A TS cookie on a plain 200 is normal session tracking; a 5xx is an origin
    // error — neither is a challenge, so they fall through to the status logic.
    if (redirected && status !== undefined && status < 500) return { vendor: "f5-bigip", kind: "challenge" };
    return null;
  }
  if (body.includes("the requested url was rejected") && body.includes("support id")) {
    return { vendor: "f5-bigip", kind: "block" };
  }

  // ── Akamai ──
  if (server.includes("akamaighost") || has(headers, "x-akamai-transformed")) {
    if (body.includes("access denied") || body.includes("pardon our interruption") || body.includes("reference #")) {
      return { vendor: "akamai", kind: "block" };
    }
    if (status === 403) return { vendor: "akamai", kind: "block" };
  }

  // ── Imperva / Incapsula ── (can return 200 with a block page!)
  if (
    has(headers, "x-iinfo") ||
    h(headers, "x-cdn").includes("incapsula") ||
    /incap_ses_|visid_incap_/.test(cookies) ||
    body.includes("incapsula incident id") ||
    body.includes("_incapsula_resource")
  ) {
    if (body.includes("request unsuccessful") || body.includes("incapsula incident id")) {
      return { vendor: "imperva", kind: "block" };
    }
    return { vendor: "imperva", kind: "ambiguous" };
  }

  // ── AWS WAF ── (x-amzn-waf-* headers; or odd status for a plain GET)
  if (has(headers, "x-amzn-waf-action") || (server.includes("awselb") && status === 403)) {
    return { vendor: "aws-waf", kind: "block" };
  }

  // ── Sucuri ──
  if (
    has(headers, "x-sucuri-id") ||
    has(headers, "x-sucuri-cache") ||
    server.includes("sucuri") ||
    body.includes("sucuri website firewall")
  ) {
    return { vendor: "sucuri", kind: "block" };
  }

  return null;
}

/**
 * Cheap vendor identification (headers/cookies only) regardless of block/challenge.
 * Used to attribute origin errors — "your Cloudflare/F5-fronted origin is erroring".
 */
function vendorOf(input: ClassifyInput): WafVendor | null {
  const { headers, setCookies = [] } = input;
  const cookies = setCookies.join("; ").toLowerCase();
  const server = h(headers, "server");
  if (!!headers?.get("cf-ray") || server.includes("cloudflare") || h(headers, "cf-mitigated")) return "cloudflare";
  if (/(^|[;\s])ts[0-9a-f]{6,}=/.test(cookies) || cookies.includes("bigipserver") || cookies.includes("f5_")) return "f5-bigip";
  if (server.includes("akamaighost") || has(headers, "x-akamai-transformed")) return "akamai";
  if (has(headers, "x-iinfo") || /incap_ses_|visid_incap_/.test(cookies)) return "imperva";
  if (has(headers, "x-amzn-waf-action")) return "aws-waf";
  if (has(headers, "x-sucuri-id") || has(headers, "x-sucuri-cache")) return "sucuri";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification (no response received)
// ─────────────────────────────────────────────────────────────────────────────

function classifyError(code: string): { classification: Classification; reason: string } {
  const c = code.toLowerCase();
  if (c.includes("timed out") || c.includes("timeout") || c.includes("aborterror") || c === "und_err_connect_timeout") {
    return { classification: "timeout", reason: "Request timed out" };
  }
  if (c.includes("enotfound") || c.includes("eai_again") || c.includes("getaddrinfo")) {
    return { classification: "dns_failed", reason: "DNS lookup failed" };
  }
  if (
    c.includes("cert") ||
    c.includes("tls") ||
    c.includes("ssl") ||
    c.includes("self signed") ||
    c.includes("unable_to_verify") ||
    c.includes("dh_key") ||
    c.includes("epproto")
  ) {
    return { classification: "tls_failed", reason: `TLS error: ${code}` };
  }
  // Connection-level failures.
  return { classification: "down_network", reason: `Connection failed: ${code}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export function classify(input: ClassifyInput): ClassifyOutput {
  // 1) No response at all → error-based classification.
  if (input.status === undefined) {
    const { classification, reason } = classifyError(input.errorCode ?? "unknown error");
    return { classification, up: isUpClassification(classification), waf: null, reason };
  }

  const status = input.status;
  const expected = input.expectedStatus ?? 200;
  const waf = detectWaf(input);

  // 2) Cloudflare 520-527 = origin unreachable behind the CDN → genuine outage.
  if (status >= 520 && status <= 527) {
    return { classification: "down_origin", up: false, waf: waf?.vendor ?? "cloudflare", reason: `Origin unreachable (HTTP ${status})` };
  }

  // 3) An evidence-backed CHALLENGE (interstitial body / F5 redirect) means the site
  //    is up even if the interstitial status looks odd (e.g. Cloudflare's 503 "Just a
  //    moment"). This is the only firewall signal allowed to outrank the 5xx guard,
  //    because it required positive proof of an interstitial — a bare 5xx never does.
  if (waf?.kind === "challenge") {
    return { classification: "up_challenged", up: true, waf: waf.vendor, reason: `${labelOf(waf.vendor)} challenge — site is up but our checks are being gated` };
  }

  // 4) A 5xx is an ORIGIN failure — a firewall can't mask it, so this is a real outage
  //    and MUST alert (this is what keeps "blocked = up" from swallowing genuine downtime).
  if (status >= 500) {
    return { classification: "down_origin", up: false, waf: waf?.vendor ?? vendorOf(input), reason: `Server error (HTTP ${status})` };
  }

  // 5) A firewall BLOCK on a non-5xx (403/429/Imperva 200 page) → site is up, don't alert.
  if (waf?.kind === "block") {
    return { classification: "up_blocked", up: true, waf: waf.vendor, reason: `${labelOf(waf.vendor)} blocked our check — site is up but the firewall is denying us` };
  }
  if (waf?.kind === "ambiguous") {
    // Imperva can serve a 200 block page; only call it down if required content is missing.
    if (input.contentMatch === false) {
      return { classification: "content_mismatch", up: false, waf: waf.vendor, reason: `${labelOf(waf.vendor)} returned a page missing the expected content` };
    }
    return { classification: "up_blocked", up: true, waf: waf.vendor, reason: `${labelOf(waf.vendor)} appears to be filtering our check — treating site as up` };
  }

  // 6) No firewall interference. Plain status + content evaluation.
  const statusOk = status === expected || (expected === 200 && status >= 200 && status < 300);

  if (statusOk) {
    if (input.contentMatch === false) {
      return { classification: "content_mismatch", up: false, waf: null, reason: "Page loaded but expected content was missing" };
    }
    return { classification: "up", up: true, waf: null, reason: "Healthy" };
  }

  // 7) Unexpected non-5xx status (e.g. 404, or a 4xx with no firewall) → real failure.
  return { classification: "down_origin", up: false, waf: null, reason: `Unexpected status ${status}` };
}

function labelOf(v: WafVendor): string {
  switch (v) {
    case "cloudflare": return "Cloudflare";
    case "akamai": return "Akamai";
    case "f5-bigip": return "F5 BIG-IP";
    case "imperva": return "Imperva";
    case "aws-waf": return "AWS WAF";
    case "sucuri": return "Sucuri";
  }
}
