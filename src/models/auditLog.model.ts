import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

const auditLogSchema = new Schema(
  {
    actorId: { type: Types.ObjectId, ref: "User", default: null },
    actorEmail: { type: String, default: "system" },
    action: { type: String, required: true },
    targetType: { type: String },
    targetId: { type: Types.ObjectId },
    ip: { type: String },
    userAgent: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLog: Model<AuditLogDoc> = model<AuditLogDoc>("AuditLog", auditLogSchema);
