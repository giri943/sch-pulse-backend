import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";
import { INCIDENT_STATUSES } from "../utils/constants";

const recommendationSnapshotSchema = new Schema(
  {
    title: { type: String, required: true },
    category: { type: String },
    steps: { type: [String], default: [] },
  },
  { _id: false },
);

const incidentSchema = new Schema(
  {
    monitorId: { type: Types.ObjectId, ref: "Monitor", required: true },
    status: { type: String, enum: INCIDENT_STATUSES, default: "open" },
    startedAt: { type: Date, required: true, default: () => new Date() },
    resolvedAt: { type: Date, default: null },
    durationSec: { type: Number, default: null },
    trigger: {
      statusCode: { type: Number },
      error: { type: String },
      responseTimeMs: { type: Number },
      /** The `Server` header that returned the failing response (nginx, cloudflare, …). */
      server: { type: String },
    },
    recommendations: { type: [recommendationSnapshotSchema], default: [] },
    rootCauseNotes: { type: String, default: "" },
    resolutionNotes: { type: String, default: "" },
    acknowledgedBy: { type: Types.ObjectId, ref: "User", default: null },
    notifiedDown: { type: Boolean, default: false },
    notifiedResolved: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// At most one OPEN incident per monitor — concurrency-safe state machine.
incidentSchema.index(
  { monitorId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "open" } },
);
incidentSchema.index({ monitorId: 1, startedAt: -1 });
incidentSchema.index({ status: 1, startedAt: -1 });

export type IncidentDoc = InferSchemaType<typeof incidentSchema>;
export const Incident: Model<IncidentDoc> = model<IncidentDoc>("Incident", incidentSchema);
