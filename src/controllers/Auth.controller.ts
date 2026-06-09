import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import { User } from "../models/user.model";
import { ApiError } from "../utils/ApiError";
import { config } from "../config";
import { logger } from "../config/logger";
import { hashPassword, verifyPassword } from "../utils/password";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { writeAudit } from "../utils/audit";

const REFRESH_COOKIE = "pulse_rt";
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: config.isProd,
  sameSite: "lax",
  domain: config.cookieDomain,
  path: "/api/v1/auth",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions);
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select("+passwordHash +tokenVersion");
  if (!user || user.status !== "active") throw ApiError.unauthorized("Invalid credentials");
  if (!(await verifyPassword(password, user.passwordHash)))
    throw ApiError.unauthorized("Invalid credentials");

  user.lastLoginAt = new Date();
  await user.save();

  setRefreshCookie(res, signRefreshToken({ sub: user.id, tv: user.tokenVersion }));
  await writeAudit(req, "user.login", { actorEmail: email, targetType: "user" });
  res.json({
    accessToken: signAccessToken({ sub: user.id, email: user.email, role: user.role }),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw ApiError.unauthorized("Missing refresh token");

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw ApiError.unauthorized("Invalid refresh token");
  }
  const user = await User.findById(payload.sub).select("+tokenVersion");
  if (!user || user.status !== "active" || user.tokenVersion !== payload.tv)
    throw ApiError.unauthorized("Refresh token revoked");

  setRefreshCookie(res, signRefreshToken({ sub: user.id, tv: user.tokenVersion }));
  res.json({ accessToken: signAccessToken({ sub: user.id, email: user.email, role: user.role }) });
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.user) await User.findByIdAndUpdate(req.user.id, { $inc: { tokenVersion: 1 } });
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions, maxAge: undefined });
  await writeAudit(req, "user.logout", { targetType: "user" });
  res.json({ success: true });
}

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const user = await User.findOne({ email: req.body.email });
  if (user) {
    const rawToken = randomBytes(32).toString("hex");
    user.set("resetPasswordToken", createHash("sha256").update(rawToken).digest("hex"));
    user.set("resetPasswordExpires", new Date(Date.now() + RESET_TOKEN_TTL_MS));
    await user.save();
    if (!config.isProd) {
      logger.info(`[dev] password reset link: ${config.appBaseUrl}/reset-password?token=${rawToken}`);
    }
  }
  // Always 200 — never reveal whether the email exists.
  res.json({ message: "If the email exists, a reset link has been sent." });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const hashed = createHash("sha256").update(req.body.token).digest("hex");
  const user = await User.findOne({
    resetPasswordToken: hashed,
    resetPasswordExpires: { $gt: new Date() },
  }).select("+resetPasswordToken +resetPasswordExpires +tokenVersion");
  if (!user) throw ApiError.badRequest("Invalid or expired reset token");

  user.passwordHash = await hashPassword(req.body.password);
  user.set("resetPasswordToken", undefined);
  user.set("resetPasswordExpires", undefined);
  user.tokenVersion += 1;
  await user.save();
  await writeAudit(req, "user.reset_password", { targetType: "user" });
  res.json({ message: "Password updated. Please log in." });
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.user!.id).lean();
  if (!user) throw ApiError.unauthorized();
  res.json({ id: String(user._id), name: user.name, email: user.email, role: user.role });
}
