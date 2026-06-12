import { logger } from "../../config/logger";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for transient network errors worth retrying (ECONNRESET, timeouts, DNS blips). */
function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true; // our timeout
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? "";
  const text = `${(err as Error)?.message ?? ""} ${code}`;
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|socket hang up|fetch failed/i.test(text);
}

/**
 * POST JSON to an email provider's HTTP API with retries. Retries transient
 * network errors (e.g. ECONNRESET from Render) and 429/5xx responses with
 * backoff; fails fast on 4xx (bad key / unverified sender won't fix on retry).
 * Resolves on a 2xx; throws with the provider's detail otherwise.
 */
export async function postJsonWithRetry(
  url: string,
  opts: { label: string; headers: Record<string, string>; body: string; attempts?: number; timeoutMs?: number },
): Promise<void> {
  const attempts = opts.attempts ?? 3;
  let lastErr: unknown;

  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      });
      if (res.ok) return;

      const detail = (await res.text().catch(() => "")).slice(0, 300);
      const retriable = res.status === 429 || res.status >= 500;
      lastErr = new Error(`${opts.label} responded ${res.status}: ${detail}`);
      if (!retriable || i === attempts) throw lastErr;
      logger.warn({ status: res.status, attempt: i }, `${opts.label}: ${res.status}, retrying`);
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || i === attempts) throw err;
      logger.warn(
        { attempt: i, err: err instanceof Error ? err.message : String(err) },
        `${opts.label}: transient network error, retrying`,
      );
    } finally {
      clearTimeout(timer);
    }
    await sleep(500 * i); // 0.5s, 1s backoff between attempts
  }
  throw lastErr;
}
