import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

/**
 * One "ticked-off" record for a project SOP in a specific period (e.g. the SOP
 * for 2026-07). Unique per (projectSop, period) so a period is done once. Rolls
 * up into the month-on-month history and the monthly client PDF.
 */
const sopCompletionSchema = new Schema(
  {
    projectSopId: { type: Types.ObjectId, ref: "ProjectSop", required: true, index: true },
    projectId: { type: Types.ObjectId, ref: "Project", required: true, index: true },
    periodKey: { type: String, required: true },
    completedBy: { type: Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
    proofKey: { type: String, default: null },
  },
  { timestamps: true },
);

sopCompletionSchema.index({ projectSopId: 1, periodKey: 1 }, { unique: true });
sopCompletionSchema.index({ projectId: 1, createdAt: -1 });

export type SopCompletionDoc = InferSchemaType<typeof sopCompletionSchema>;
export const SopCompletion: Model<SopCompletionDoc> = model<SopCompletionDoc>("SopCompletion", sopCompletionSchema);
