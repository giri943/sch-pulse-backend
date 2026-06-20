import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

/** A user's role *within* a project (layered on top of their global role). */
export const PROJECT_ROLES = ["owner", "editor", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

const projectMemberSchema = new Schema(
  {
    projectId: { type: Types.ObjectId, ref: "Project", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: PROJECT_ROLES, default: "viewer" },
    /** Who added them (owner who approved/invited), null for the original creator. */
    addedBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// One membership row per (project, user).
projectMemberSchema.index({ projectId: 1, userId: 1 }, { unique: true });

export type ProjectMemberDoc = InferSchemaType<typeof projectMemberSchema>;
export const ProjectMember: Model<ProjectMemberDoc> = model<ProjectMemberDoc>(
  "ProjectMember",
  projectMemberSchema,
);
