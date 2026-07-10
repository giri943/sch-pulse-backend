import { Schema, model, type InferSchemaType, type Model } from "mongoose";

/**
 * Org-wide RCA-reminder policy — a single document (`key: "global"`). Controls
 * the nudges sent to owners/members when a resolved incident still has no
 * root-cause analysis. Enabled by default (preserves prior hard-coded behaviour):
 * a nudge every `everyHours`, for up to `windowDays` after resolution.
 */
const rcaReminderPolicySchema = new Schema(
  {
    key: { type: String, default: "global", unique: true },
    enabled: { type: Boolean, default: true },
    /** Cadence between reminders for the same incident, in minutes (default 24h). */
    everyMinutes: { type: Number, default: 24 * 60, min: 1, max: 90 * 24 * 60 },
    /** Stop reminding once the incident resolved more than this many minutes ago (default 7d). */
    windowMinutes: { type: Number, default: 7 * 24 * 60, min: 1, max: 90 * 24 * 60 },
  },
  { timestamps: true },
);

export type RcaReminderPolicyDoc = InferSchemaType<typeof rcaReminderPolicySchema>;
export const RcaReminderPolicy: Model<RcaReminderPolicyDoc> = model<RcaReminderPolicyDoc>(
  "RcaReminderPolicy",
  rcaReminderPolicySchema,
);
