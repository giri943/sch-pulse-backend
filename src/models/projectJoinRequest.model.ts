import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

export const JOIN_REQUEST_STATUSES = ["pending", "accepted", "rejected", "cancelled"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

const joinRequestSchema = new Schema(
  {
    projectId: { type: Types.ObjectId, ref: "Project", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    message: { type: String, default: "", maxlength: 500 },
    status: { type: String, enum: JOIN_REQUEST_STATUSES, default: "pending", index: true },
    /** Owner who accepted/rejected, and when. */
    decidedBy: { type: Types.ObjectId, ref: "User" },
    decidedAt: { type: Date },
    /** Role granted on acceptance. */
    grantedRole: { type: String },
  },
  { timestamps: true },
);

// At most one *pending* request per (project, user).
joinRequestSchema.index(
  { projectId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);

export type ProjectJoinRequestDoc = InferSchemaType<typeof joinRequestSchema>;
export const ProjectJoinRequest: Model<ProjectJoinRequestDoc> = model<ProjectJoinRequestDoc>(
  "ProjectJoinRequest",
  joinRequestSchema,
);
