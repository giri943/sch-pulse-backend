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

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl } as SignOptions);

export const signRefreshToken = (payload: RefreshTokenPayload): string =>
  jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshTtl } as SignOptions);

export const verifyAccessToken = (token: string): AccessTokenPayload =>
  jwt.verify(token, config.jwt.accessSecret) as AccessTokenPayload;

export const verifyRefreshToken = (token: string): RefreshTokenPayload =>
  jwt.verify(token, config.jwt.refreshSecret) as RefreshTokenPayload;
