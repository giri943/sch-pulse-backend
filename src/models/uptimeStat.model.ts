import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

const uptimeStatSchema = new Schema(
  {
    monitorId: { type: Types.ObjectId, ref: "Monitor", required: true },
    bucket: { type: String, default: "hour" },
    bucketStart: { type: Date, required: true },
    ups: { type: Number, default: 0 },
    downs: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
    sumResponseMs: { type: Number, default: 0 },
    maxResponseMs: { type: Number, default: 0 },
  },
  { timestamps: false },
);

uptimeStatSchema.index({ monitorId: 1, bucketStart: 1 }, { unique: true });
// Dashboard/analytics roll up across monitors by time window — index bucketStart alone.
uptimeStatSchema.index({ bucketStart: 1 });

export type UptimeStatDoc = InferSchemaType<typeof uptimeStatSchema>;
export const UptimeStat: Model<UptimeStatDoc> = model<UptimeStatDoc>("UptimeStat", uptimeStatSchema);
