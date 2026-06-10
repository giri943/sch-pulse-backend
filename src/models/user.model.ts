import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";
import { USER_STATUSES } from "../utils/constants";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Optional: Google-only users have no password.
    passwordHash: { type: String, select: false },
    role: { type: Types.ObjectId, ref: "Role", required: true, index: true },
    status: { type: String, enum: USER_STATUSES, default: "active" },

    // Auth provider
    authProvider: { type: String, enum: ["local", "google"], default: "local" },
    googleId: { type: String, index: true, sparse: true },
    avatarUrl: { type: String },

    tokenVersion: { type: Number, default: 0 },
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.index({ name: "text", email: "text" });

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User: Model<UserDoc> = model<UserDoc>("User", userSchema);
