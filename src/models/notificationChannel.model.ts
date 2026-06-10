import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

/** Channel types — extensible (google_chat now; whatsapp planned). */
export const CHANNEL_TYPES = ["google_chat"] as const;

const channelSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: CHANNEL_TYPES, default: "google_chat" },
    /** Google Chat incoming-webhook URL (space-scoped). */
    webhookUrl: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    createdBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export type NotificationChannelDoc = InferSchemaType<typeof channelSchema>;
export const NotificationChannel: Model<NotificationChannelDoc> = model<NotificationChannelDoc>(
  "NotificationChannel",
  channelSchema,
);
