import type { MonitorDoc } from "../../models/monitor.model";
import type { Classification, WafVendor } from "./classify";

export interface CheckResult {
  up: boolean;
  statusCode?: number;
  responseTimeMs?: number;
  error?: string | null;
  /** SSL only: certificate expiry. */
  sslExpiresAt?: Date;
  /** WAF-aware outcome classification (set by the website/api checks). */
  classification?: Classification;
  /** Firewall detected in front of the target, if any. */
  waf?: WafVendor | null;
}

export type MonitorWithId = MonitorDoc & { _id: unknown };
export type CheckFn = (monitor: MonitorWithId) => Promise<CheckResult>;

/** Normalize fetch/network errors into a short, recognizable message. */
export function normalizeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "Request timed out";
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code) return cause.code;
    return err.message;
  }
  return String(err);
}
