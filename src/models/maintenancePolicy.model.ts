import { Schema, model, type InferSchemaType, type Model } from "mongoose";

/**
 * Org-wide maintenance defaults — a single document (`key: "global"`).
 * `defaultDurationMinutes` pre-fills the duration when scheduling a window.
 */
const maintenancePolicySchema = new Schema(
  {
    key: { type: String, default: "global", unique: true },
    defaultDurationMinutes: { type: Number, default: 60, min: 5, max: 7 * 24 * 60 },
  },
  { timestamps: true },
);

export type MaintenancePolicyDoc = InferSchemaType<typeof maintenancePolicySchema>;
export const MaintenancePolicy: Model<MaintenancePolicyDoc> = model<MaintenancePolicyDoc>(
  "MaintenancePolicy",
  maintenancePolicySchema,
);
