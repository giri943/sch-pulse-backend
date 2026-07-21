import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

export const MAINTENANCE_SCOPES = ["monitor", "project"] as const;
export const MAINTENANCE_SOURCES = ["manual", "deploy-token"] as const;

/**
 * A planned maintenance/deploy window. While active (now ∈ [startAt, endAt] and
 * not canceled) the target's checks still run, but failures don't open incidents
 * or send alerts and are excluded from SLA — planned downtime never false-alarms.
 * Targets a single monitor OR a whole project (all its monitors).
 */
const maintenanceWindowSchema = new Schema(
  {
    scope: { type: String, enum: MAINTENANCE_SCOPES, required: true },
    monitorId: { type: Types.ObjectId, ref: "Monitor", default: null },
    projectId: { type: Types.ObjectId, ref: "Project", default: null },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    // Rich text (sanitized HTML) — the reason + embedded proof screenshots.
    reason: { type: String, default: "" },
    /** @-mentioned users to notify when the window is created. */
    reasonMentions: { type: [Types.ObjectId], ref: "User", default: [] },
    /** Legacy: S3 key for a separately-uploaded proof (superseded by inline images). */
    proofKey: { type: String, default: null },
    createdBy: { type: Types.ObjectId, ref: "User", default: null },
    source: { type: String, enum: MAINTENANCE_SOURCES, default: "manual" },
    canceledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Fast "is anything active right now" scans for the suppression check.
maintenanceWindowSchema.index({ canceledAt: 1, startAt: 1, endAt: 1 });
maintenanceWindowSchema.index({ monitorId: 1, startAt: -1 });
maintenanceWindowSchema.index({ projectId: 1, startAt: -1 });

export type MaintenanceWindowDoc = InferSchemaType<typeof maintenanceWindowSchema>;
export const MaintenanceWindow: Model<MaintenanceWindowDoc> = model<MaintenanceWindowDoc>(
  "MaintenanceWindow",
  maintenanceWindowSchema,
);
