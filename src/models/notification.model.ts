import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

export const NOTIFICATION_TYPES = ["mention", "project", "incident", "maintenance", "expiry"] as const;

/**
 * A per-user in-app notification (the bell). Created on events the user cares
 * about; the client refetches instantly via the SSE "notifications" event.
 * Auto-expires after 60 days so the collection stays small.
 */
const notificationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    link: { type: String, default: null },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema>;
export const Notification: Model<NotificationDoc> = model<NotificationDoc>("Notification", notificationSchema);
