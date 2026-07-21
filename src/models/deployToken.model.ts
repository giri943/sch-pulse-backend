import { Schema, model, Types, type InferSchemaType, type Model } from "mongoose";

/**
 * A per-project deploy-suppress token. CI/CD sends it (header X-Deploy-Token) to
 * open a maintenance window during a deploy so alerts stay quiet. Only the SHA-256
 * hash is stored — the plaintext is shown once at creation and never again.
 */
const deployTokenSchema = new Schema(
  {
    projectId: { type: Types.ObjectId, ref: "Project", required: true, index: true },
    name: { type: String, default: "" },
    tokenHash: { type: String, required: true, unique: true },
    /** First chars of the token (e.g. "pdt_ab12cd…") for display. */
    prefix: { type: String, required: true },
    createdBy: { type: Types.ObjectId, ref: "User", default: null },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type DeployTokenDoc = InferSchemaType<typeof deployTokenSchema>;
export const DeployToken: Model<DeployTokenDoc> = model<DeployTokenDoc>("DeployToken", deployTokenSchema);
