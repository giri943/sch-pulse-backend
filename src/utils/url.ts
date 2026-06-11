/**
 * Normalize a monitor URL into a comparison key used to detect duplicate
 * monitors for the same target. Collapses differences that point at the same
 * resource: scheme (http/https), host casing, default ports, and trailing
 * slashes. Path (which can be case-sensitive) and query string are preserved.
 *
 * e.g. "https://Example.com/", "http://example.com", "https://example.com:443"
 *      all normalize to "example.com".
 */
export function normalizeUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    const port = u.port && u.port !== "80" && u.port !== "443" ? `:${u.port}` : "";
    const path = u.pathname.replace(/\/+$/, ""); // drop trailing slash(es)
    return `${host}${port}${path}${u.search}`;
  } catch {
    // Not a parseable URL — fall back to a best-effort key.
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}
