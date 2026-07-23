import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

const projectSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: "" },
    createdBy: { type: Types.ObjectId, ref: "User" },
    /** The seeded "General" project — cannot be deleted; holds ungrouped monitors. */
    isSystem: { type: Boolean, default: false },
    /** Server-maintenance (SOP) plan: whether this project has one + who owns it. */
    hasServerMaintenance: { type: Boolean, default: false },
    maintenanceOwnerId: { type: Types.ObjectId, ref: "User", default: null },
    /** Google Chat / notification channels that SOP upcoming/overdue alerts fan out to. */
    channels: { type: [Types.ObjectId], ref: "NotificationChannel", default: [] },
  },
  { timestamps: true },
);

export type ProjectDoc = InferSchemaType<typeof projectSchema>;
export const Project: Model<ProjectDoc> = model<ProjectDoc>("Project", projectSchema);

/** Default project that always exists; new/ungrouped monitors fall back to it. */
export const GENERAL_PROJECT = "General";
