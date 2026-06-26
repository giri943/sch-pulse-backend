import jwt, { type SignOptions } from "jsonwebtoken";
import { config } from "../config";

export interface AccessTokenPayload {
  sub: string;
  email: string;
}
export interface RefreshTokenPayload {
  sub: string;
  tv: number;
}

// Pin HS256 explicitly on both sign and verify. This prevents algorithm-
// confusion attacks (a forged token claiming "alg":"none" or a different
// algorithm is rejected at verification).
const ALG = "HS256" as const;

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, config.jwt.accessSecret, { algorithm: ALG, expiresIn: config.jwt.accessTtl } as SignOptions);

export const signRefreshToken = (payload: RefreshTokenPayload): string =>
  jwt.sign(payload, config.jwt.refreshSecret, { algorithm: ALG, expiresIn: config.jwt.refreshTtl } as SignOptions);

export const verifyAccessToken = (token: string): AccessTokenPayload =>
  jwt.verify(token, config.jwt.accessSecret, { algorithms: [ALG] }) as AccessTokenPayload;

export const verifyRefreshToken = (token: string): RefreshTokenPayload =>
  jwt.verify(token, config.jwt.refreshSecret, { algorithms: [ALG] }) as RefreshTokenPayload;
