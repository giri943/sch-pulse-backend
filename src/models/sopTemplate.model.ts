import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";
import { SOP_FREQUENCIES } from "../utils/constants";

/**
 * A reusable SOP task in the central library (super-admin governed). Created
 * once, then attached to any project's maintenance plan. Attaching snapshots
 * the text onto the project, so editing/archiving here never rewrites history.
 */
const sopTemplateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    category: { type: String, default: "" },
    steps: { type: [String], default: [] },
    /** Convenience default that prefills the frequency when attaching. */
    defaultFrequency: { type: String, enum: SOP_FREQUENCIES, default: "monthly" },
    archived: { type: Boolean, default: false },
    createdBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

sopTemplateSchema.index({ archived: 1, category: 1, name: 1 });

export type SopTemplateDoc = InferSchemaType<typeof sopTemplateSchema>;
export const SopTemplate: Model<SopTemplateDoc> = model<SopTemplateDoc>("SopTemplate", sopTemplateSchema);
