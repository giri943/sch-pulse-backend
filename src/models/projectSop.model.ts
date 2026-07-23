import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";
import { SOP_FREQUENCIES } from "../utils/constants";

/**
 * A library SOP attached to a project's maintenance plan, with a per-project
 * frequency. The name/description/steps are SNAPSHOTTED from the template at
 * attach time, so later library edits/retirement never rewrite this project's
 * plan or its historical completions.
 */
const projectSopSchema = new Schema(
  {
    projectId: { type: Types.ObjectId, ref: "Project", required: true, index: true },
    templateId: { type: Types.ObjectId, ref: "SopTemplate", default: null },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    category: { type: String, default: "" },
    steps: { type: [String], default: [] },
    frequency: { type: String, enum: SOP_FREQUENCIES, required: true },
    /** Optional per-SOP owner; falls back to the project's maintenance owner. */
    ownerId: { type: Types.ObjectId, ref: "User", default: null },
    active: { type: Boolean, default: true },
    /** Last period we nudged the owner about "due soon" (dedupes upcoming reminders). */
    lastRemindedPeriod: { type: String, default: null },
    /** Last *elapsed* period we flagged as missed (dedupes overdue/pending reminders). */
    lastOverduePeriod: { type: String, default: null },
    createdBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

projectSopSchema.index({ projectId: 1, active: 1 });

export type ProjectSopDoc = InferSchemaType<typeof projectSopSchema>;
export const ProjectSop: Model<ProjectSopDoc> = model<ProjectSopDoc>("ProjectSop", projectSopSchema);
