import { Schema, model, type InferSchemaType, type Model } from "mongoose";
import { RULE_CATEGORIES, RULE_MATCH_TYPES } from "../utils/constants";

const ruleSchema = new Schema(
  {
    name: { type: String, required: true },
    matchType: { type: String, enum: RULE_MATCH_TYPES, required: true },
    matchValue: { type: String, required: true },
    category: { type: String, enum: RULE_CATEGORIES, required: true },
    title: { type: String, required: true },
    steps: { type: [String], default: [] },
    priority: { type: Number, default: 100 },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

ruleSchema.index({ matchType: 1, matchValue: 1, enabled: 1 });

export type RecommendationRuleDoc = InferSchemaType<typeof ruleSchema>;
export const RecommendationRule: Model<RecommendationRuleDoc> = model<RecommendationRuleDoc>(
  "RecommendationRule",
  ruleSchema,
);
