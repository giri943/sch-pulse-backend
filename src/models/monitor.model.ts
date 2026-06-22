import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";
import {
  API_ASSERTION_OPERATORS,
  HTTP_METHODS,
  MONITOR_INTERVALS_SEC,
  MONITOR_STATUSES,
  MONITOR_TYPES,
} from "../utils/constants";

const assertionSchema = new Schema(
  {
    jsonPath: { type: String, required: true },
    operator: { type: String, enum: API_ASSERTION_OPERATORS, required: true },
    value: { type: String },
  },
  { _id: false },
);

const monitorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: MONITOR_TYPES, required: true },
    url: { type: String, required: true },
    method: { type: String, enum: HTTP_METHODS, default: "GET" },
    timeoutMs: { type: Number, default: 10000 },
    expectedStatusCode: { type: Number, default: 200 },
    intervalSec: { type: Number, enum: MONITOR_INTERVALS_SEC, default: 300 },
    headers: { type: Schema.Types.Mixed },
    body: { type: String },
    assertions: { type: [assertionSchema], default: undefined },
    /** Project this monitor belongs to (grouping). Back-filled to "General" on boot. */
    projectId: { type: Types.ObjectId, ref: "Project", index: true },
    /** Owner + tagged users (visibility + alerts). */
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    members: { type: [Types.ObjectId], ref: "User", default: [] },
    /** Extra non-user emails to also alert (e.g. a client contact). */
    extraAlertEmails: { type: [String], default: [] },
    /** Notification channels (Google Chat, …) to fan alerts out to. */
    channels: { type: [Types.ObjectId], ref: "NotificationChannel", default: [] },
    enabled: { type: Boolean, default: true },

    // ─── lifecycle / monitoring period ───
    /** End of the monitoring period. null = monitor indefinitely. */
    expiresAt: { type: Date, default: null },
    /** Day-marks (e.g. 3,2,1) already reminded, to dedupe daily reminders. */
    expiryRemindersSent: { type: [Number], default: [] },
    /** Set when the monitoring period lapsed; hard-deleted 7 days later. */
    softDeletedAt: { type: Date, default: null },

    // ─── runtime state (written by the monitoring service) ───
    status: { type: String, enum: MONITOR_STATUSES, default: "unknown" },
    consecutiveFailures: { type: Number, default: 0 },
    currentIncidentId: { type: Types.ObjectId, ref: "Incident", default: null },
    lastCheckedAt: { type: Date },
    lastResponseTimeMs: { type: Number },
    nextRunAt: { type: Date, default: () => new Date() },
    /** Latest WAF-aware classification (e.g. up, up_blocked, up_challenged). */
    lastClassification: { type: String, default: null },
    /** Firewall detected in front of this target (cloudflare, f5-bigip, …); null if none. */
    waf: { type: String, default: null },
    /** When the firewall was last observed interfering with our checks. */
    wafDetectedAt: { type: Date, default: null },
    sslExpiresAt: { type: Date },
    sslWarnedThresholds: { type: [Number], default: [] },
    // ─── domain registration expiry (via RDAP, refreshed ~daily) ───
    domainExpiresAt: { type: Date },
    domainCheckedAt: { type: Date },
    domainWarnedThresholds: { type: [Number], default: [] },
  },
  { timestamps: true },
);

// Scheduler hot path: enabled monitors that are due.
monitorSchema.index({ enabled: 1, nextRunAt: 1 });
monitorSchema.index({ type: 1 });
monitorSchema.index({ status: 1 });
monitorSchema.index({ sslExpiresAt: 1 });
monitorSchema.index({ createdBy: 1 });
monitorSchema.index({ members: 1 });
monitorSchema.index({ softDeletedAt: 1 });
monitorSchema.index({ expiresAt: 1 });

export type MonitorDoc = InferSchemaType<typeof monitorSchema>;
export const Monitor: Model<MonitorDoc> = model<MonitorDoc>("Monitor", monitorSchema);
