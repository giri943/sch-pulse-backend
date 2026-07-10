/**
 * Translate a technical check failure into one plain, direct sentence a
 * non-technical reader understands. Derived from the incident's stored
 * `statusCode` + `error` (the classifier's reason) and, when available, the
 * `server` that responded (e.g. nginx, cloudflare) — so it needs no extra data.
 *
 * Wording stays generic ("server"/"service") since this monitors websites,
 * APIs and services alike. The technical detail (HTTP code, raw error) is still
 * shown alongside for engineers — this only adds the "what this means" line.
 */

/** Canonical HTTP status names so 502 reads as "502 Bad Gateway", not just "502". */
const HTTP_NAME: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** "502 Bad Gateway" | "500 Internal Server Error" | just the code if unnamed. */
function codeLabel(code: number): string {
  const name = HTTP_NAME[code];
  return name ? `${code} ${name}` : String(code);
}

/** The product name that responded, cleaned up: "nginx/1.18.0" → "nginx". */
function cleanServer(server: string): string {
  return server.split(/[/\s]/)[0].trim();
}

export function humanizeError(input: { statusCode?: number | null; error?: string | null; server?: string | null }): string {
  const code = input.statusCode ?? null;
  const err = (input.error ?? "").toLowerCase();
  // Where the error came from — only meaningful when there was a response
  // (connection/timeout/DNS errors have no server). Two forms so it reads cleanly
  // whether the code is bare ("… 502 Bad Gateway (reported by nginx)") or already
  // in parentheses ("… (500 Internal Server Error, reported by nginx)").
  const who = input.server ? cleanServer(input.server) : "";
  const src = who ? ` (reported by ${who})` : ""; //     bare-code form
  const srcIn = who ? `, reported by ${who}` : ""; //     inside-parens form

  // No HTTP response — connection / timeout / DNS / TLS (read from the error text).
  if (err.includes("timed out") || err.includes("timeout")) {
    return "The server is taking too long to respond (over 30 seconds). It's either very slow, overloaded, or down.";
  }
  if (err.includes("dns")) {
    return "We couldn't resolve the server's address (DNS). The domain may be expired or its DNS settings are broken.";
  }
  if (err.includes("tls") || err.includes("ssl") || err.includes("cert")) {
    return "The server's security certificate isn't working. Clients will likely see a 'not secure' warning.";
  }
  if (err.includes("origin unreachable")) {
    return `The server can't be reached${src}. Looks like the hosting or CDN can't reach the origin.`;
  }
  if (err.includes("connection failed") || err.includes("refused") || err.includes("reset") || err.includes("unreachable")) {
    return "We couldn't connect to the server at all. It looks completely down.";
  }
  if (err.includes("expected content")) {
    return `The response loaded but didn't contain what we expected${src}. It may be returning an error or the wrong content.`;
  }

  // HTTP status based.
  if (code != null) {
    if (code >= 520 && code <= 527) return `The server can't be reached${src}. Looks like the hosting or CDN can't reach the origin.`;
    if (code === 502 || code === 503 || code === 504) {
      return `The server returned a ${codeLabel(code)}${src}. It's reachable but can't handle requests right now — usually a temporary overload or restart on the hosting side.`;
    }
    if (code >= 500) return `The server hit an internal error (${codeLabel(code)}${srcIn}). Something crashed on its side.`;
    if (code === 429) return `The server is getting too many requests and is throttling (${codeLabel(code)}${srcIn}). It's up, just limiting traffic.`;
    if (code === 404) return `The URL we're checking wasn't found (${codeLabel(code)}${srcIn}). It may have changed or been removed.`;
    if (code === 401 || code === 403) return `The server blocked our check (${codeLabel(code)}${srcIn}). It may now need a login or is blocking automated access.`;
    if (code >= 400) return `The server rejected our request (${codeLabel(code)}${srcIn}). Something about the endpoint or its setup may be off.`;
  }

  return "Our check failed — we couldn't confirm the service is working. It may be down.";
}
