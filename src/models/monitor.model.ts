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
    /** Emails alerted when this monitor goes down / recovers / SSL nears expiry. */
    alertRecipients: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },

    // ─── runtime state (written by the monitoring service) ───
    status: { type: String, enum: MONITOR_STATUSES, default: "unknown" },
    consecutiveFailures: { type: Number, default: 0 },
    currentIncidentId: { type: Types.ObjectId, ref: "Incident", default: null },
    lastCheckedAt: { type: Date },
    lastResponseTimeMs: { type: Number },
    nextRunAt: { type: Date, default: () => new Date() },
    sslExpiresAt: { type: Date },
    sslWarnedThresholds: { type: [Number], default: [] },
  },
  { timestamps: true },
);

// Scheduler hot path: enabled monitors that are due.
monitorSchema.index({ enabled: 1, nextRunAt: 1 });
monitorSchema.index({ type: 1 });
monitorSchema.index({ status: 1 });
monitorSchema.index({ sslExpiresAt: 1 });

export type MonitorDoc = InferSchemaType<typeof monitorSchema>;
export const Monitor: Model<MonitorDoc> = model<MonitorDoc>("Monitor", monitorSchema);
