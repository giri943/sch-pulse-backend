import { Schema, model, type InferSchemaType, type Model } from "mongoose";

const roleSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: "" },
    /** Permission keys from utils/permissions.ts */
    permissions: { type: [String], default: [] },
    /** System roles (Super Admin, Member) cannot be deleted. */
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type RoleDoc = InferSchemaType<typeof roleSchema>;
export const Role: Model<RoleDoc> = model<RoleDoc>("Role", roleSchema);

export const SUPER_ADMIN_ROLE = "Super Admin";
export const MEMBER_ROLE = "Member";
