import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { User } from "../models/user.model";
import { Role, MEMBER_ROLE } from "../models/role.model";
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

interface PopulatedRole {
  _id: unknown;
  name: string;
  permissions: string[];
}

/** Shape the auth response: set refresh cookie, return access token + user (with role/perms). */
function sendSession(
  res: Response,
  user: { id: string; name: string; email: string; tokenVersion: number; avatarUrl?: string | null; role: PopulatedRole },
) {
  res.cookie(REFRESH_COOKIE, signRefreshToken({ sub: user.id, tv: user.tokenVersion }), refreshCookieOptions);
  res.json({
    accessToken: signAccessToken({ sub: user.id, email: user.email }),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl ?? null,
      role: { id: String(user.role._id), name: user.role.name },
      permissions: user.role.permissions ?? [],
    },
  });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  const user = await User.findOne({ email })
    .select("+passwordHash +tokenVersion")
    .populate<{ role: PopulatedRole }>("role", "name permissions");
  if (!user || user.status !== "active") throw ApiError.unauthorized("Invalid credentials");
  if (!user.passwordHash) throw ApiError.unauthorized("This account uses Google sign-in");
  if (!(await verifyPassword(password, user.passwordHash))) throw ApiError.unauthorized("Invalid credentials");

  user.lastLoginAt = new Date();
  await user.save();
  await writeAudit(req, "user.login", { actorEmail: email, targetType: "user" });
  sendSession(res, {
    id: user.id,
    name: user.name,
    email: user.email,
    tokenVersion: user.tokenVersion,
    avatarUrl: user.avatarUrl,
    role: user.role,
  });
}

export async function googleLogin(req: Request, res: Response): Promise<void> {
  if (!config.google.clientId) throw ApiError.badRequest("Google sign-in is not configured");
  const { idToken } = req.body;

  const client = new OAuth2Client(config.google.clientId);
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: config.google.clientId });
    payload = ticket.getPayload();
  } catch {
    throw ApiError.unauthorized("Invalid Google token");
  }
  if (!payload?.email || !payload.email_verified) throw ApiError.unauthorized("Google email not verified");

  const email = payload.email.toLowerCase();
  if (email.split("@")[1] !== config.google.allowedDomain) {
    throw ApiError.forbidden(`Only ${config.google.allowedDomain} accounts can sign in`);
  }

  let user = await User.findOne({ email })
    .select("+tokenVersion")
    .populate<{ role: PopulatedRole }>("role", "name permissions");

  if (!user) {
    const memberRole = await Role.findOne({ name: MEMBER_ROLE });
    if (!memberRole) throw ApiError.badRequest("Default role missing — run the seed");
    const created = await User.create({
      name: payload.name ?? email,
      email,
      role: memberRole._id,
      authProvider: "google",
      googleId: payload.sub,
      avatarUrl: payload.picture,
      status: "active",
    });
    user = await User.findById(created._id)
      .select("+tokenVersion")
      .populate<{ role: PopulatedRole }>("role", "name permissions");
    logger.info({ email }, "Auto-provisioned Google user");
  } else if (!user.googleId) {
    user.googleId = payload.sub;
    if (payload.picture) user.avatarUrl = payload.picture;
    await user.save();
  }

  if (!user || user.status !== "active") throw ApiError.forbidden("Account is disabled");

  user.lastLoginAt = new Date();
  await user.save();
  await writeAudit(req, "user.login.google", { actorEmail: email, targetType: "user" });
  sendSession(res, {
    id: user.id,
    name: user.name,
    email: user.email,
    tokenVersion: user.tokenVersion,
    avatarUrl: user.avatarUrl,
    role: user.role,
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
  if (!user || user.status !== "active" || user.tokenVersion !== payload.tv) {
    throw ApiError.unauthorized("Refresh token revoked");
  }
  res.cookie(REFRESH_COOKIE, signRefreshToken({ sub: user.id, tv: user.tokenVersion }), refreshCookieOptions);
  res.json({ accessToken: signAccessToken({ sub: user.id, email: user.email }) });
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
    if (!config.isProd) logger.info(`[dev] reset link: ${config.appBaseUrl}/reset-password?token=${rawToken}`);
  }
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
  const user = await User.findById(req.user!.id).populate<{ role: PopulatedRole }>("role", "name permissions").lean();
  if (!user) throw ApiError.unauthorized();
  const role = user.role as unknown as PopulatedRole;
  res.json({
    id: String(user._id),
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl ?? null,
    role: { id: String(role._id), name: role.name },
    permissions: role.permissions ?? [],
  });
}
