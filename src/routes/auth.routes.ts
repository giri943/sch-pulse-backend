import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import * as AuthController from "../controllers/Auth.controller";
import { validate } from "../middlewares/validate";
import { authenticate } from "../middlewares/auth";
import { authRateLimiter } from "../middlewares/rateLimit";
import { catchAsync } from "../utils/catchAsync";
import { config } from "../config";
import { ApiError } from "../utils/ApiError";
import {
  forgotPasswordSchema,
  loginSchema,
  passwordSchema,
  resetPasswordSchema,
} from "../validations/auth.validation";

const googleSchema = z.object({ idToken: z.string().min(10) });
const setPasswordSchema = z.object({ password: passwordSchema });

/**
 * Guard for the email/password endpoints. The app is Google-only by default;
 * these routes only work when AUTH_PASSWORD_LOGIN_ENABLED=true (break-glass).
 */
function requirePasswordLogin(_req: Request, _res: Response, next: NextFunction): void {
  if (!config.auth.passwordLoginEnabled) {
    next(new ApiError(403, "Password login is disabled — please sign in with Google.", "PASSWORD_LOGIN_DISABLED"));
    return;
  }
  next();
}

const router = Router();

router.post("/login", requirePasswordLogin, authRateLimiter, validate({ body: loginSchema }), catchAsync(AuthController.login));
router.post("/google", authRateLimiter, validate({ body: googleSchema }), catchAsync(AuthController.googleLogin));
router.get("/config", catchAsync(AuthController.authConfig));
router.post("/refresh", catchAsync(AuthController.refresh));
router.post("/logout", authenticate, catchAsync(AuthController.logout));
router.post(
  "/forgot-password",
  requirePasswordLogin,
  authRateLimiter,
  validate({ body: forgotPasswordSchema }),
  catchAsync(AuthController.forgotPassword),
);
router.post(
  "/reset-password",
  requirePasswordLogin,
  validate({ body: resetPasswordSchema }),
  catchAsync(AuthController.resetPassword),
);
router.get("/me", authenticate, catchAsync(AuthController.me));
router.post(
  "/set-password",
  requirePasswordLogin,
  authenticate,
  validate({ body: setPasswordSchema }),
  catchAsync(AuthController.setPassword),
);

export default router;
