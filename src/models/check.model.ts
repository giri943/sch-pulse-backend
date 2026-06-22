import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

const checkSchema = new Schema(
  {
    monitorId: { type: Types.ObjectId, ref: "Monitor", required: true },
    checkedAt: { type: Date, required: true, default: () => new Date() },
    up: { type: Boolean, required: true },
    statusCode: { type: Number },
    responseTimeMs: { type: Number },
    error: { type: String, default: null },
    /** WAF-aware classification of this check (e.g. up, up_blocked, down_origin). */
    classification: { type: String },
    /** Firewall detected in front of the target on this check, if any. */
    waf: { type: String, default: null },
  },
  { timestamps: false },
);

checkSchema.index({ monitorId: 1, checkedAt: -1 });
// TTL: raw checks expire after 90 days to bound the hot collection.
checkSchema.index({ checkedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export type CheckDoc = InferSchemaType<typeof checkSchema>;
export const Check: Model<CheckDoc> = model<CheckDoc>("Check", checkSchema);
