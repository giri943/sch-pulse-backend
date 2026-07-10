import { Schema, model, type InferSchemaType, type Model } from "mongoose";

/**
 * Org-wide escalation policy — a single document (`key: "global"`). When enabled,
 * an incident left open longer than `afterMinutes` is escalated by email/chat to
 * the `emails` (leadership). Off by default, so nothing escalates until a
 * super-admin configures and enables it.
 */
const escalationPolicySchema = new Schema(
  {
    key: { type: String, default: "global", unique: true },
    enabled: { type: Boolean, default: false },
    afterMinutes: { type: Number, default: 60, min: 1 },
    emails: { type: [String], default: [] },
  },
  { timestamps: true },
);

export type EscalationPolicyDoc = InferSchemaType<typeof escalationPolicySchema>;
export const EscalationPolicy: Model<EscalationPolicyDoc> = model<EscalationPolicyDoc>(
  "EscalationPolicy",
  escalationPolicySchema,
);
