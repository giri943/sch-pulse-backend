import type { Request, Response, NextFunction } from "express";
import { DeployToken } from "../models/deployToken.model";
import { ApiError } from "../utils/ApiError";
import { sha256 } from "../utils/deployToken";

/**
 * Authenticate a CI/CD deploy token from the `X-Deploy-Token` header (not a user
 * JWT). Sets req.deployToken with the token's project. Touches lastUsedAt.
 */
export async function authenticateDeployToken(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const raw = req.header("x-deploy-token");
  if (!raw) throw ApiError.unauthorized("Missing deploy token (X-Deploy-Token header)");

  const token = await DeployToken.findOne({ tokenHash: sha256(raw), revokedAt: null }).lean();
  if (!token) throw ApiError.unauthorized("Invalid or revoked deploy token");

  req.deployToken = { id: String(token._id), projectId: String(token.projectId) };
  void DeployToken.updateOne({ _id: token._id }, { lastUsedAt: new Date() }).catch(() => {});
  next();
}
