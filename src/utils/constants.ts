export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const MONITOR_TYPES = ["website", "api", "ssl"] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export const HTTP_METHODS = ["GET", "POST", "HEAD", "PUT"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const MONITOR_STATUSES = ["operational", "degraded", "down", "paused", "unknown"] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

/** Allowed monitoring intervals in seconds: 1/5/15/30 minutes. */
export const MONITOR_INTERVALS_SEC = [60, 300, 900, 1800] as const;

export const INCIDENT_STATUSES = ["open", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Consecutive failures required before an incident is opened (and alerts fire). */
export const FAILURE_THRESHOLD = 2;

/** SSL expiry warning thresholds in days. */
export const SSL_WARN_DAYS = [30, 15, 7] as const;

/** Domain-registration expiry warning thresholds in days. */
export const DOMAIN_WARN_DAYS = [30, 15, 7] as const;

export const RULE_MATCH_TYPES = ["statusCode", "errorContains", "category"] as const;
export const RULE_CATEGORIES = ["web", "api", "ssl", "dns", "db", "infra"] as const;
export const API_ASSERTION_OPERATORS = ["equals", "exists", "contains"] as const;

export const UPTIME_RANGES = ["24h", "7d", "30d"] as const;
export type UptimeRange = (typeof UPTIME_RANGES)[number];
