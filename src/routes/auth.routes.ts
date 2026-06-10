import { Router } from "express";
import { z } from "zod";
import * as AuthController from "../controllers/Auth.controller";
import { validate } from "../middlewares/validate";
import { authenticate } from "../middlewares/auth";
import { authRateLimiter } from "../middlewares/rateLimit";
import { catchAsync } from "../utils/catchAsync";
import {
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
} from "../validations/auth.validation";

const googleSchema = z.object({ idToken: z.string().min(10) });

const router = Router();

router.post("/login", authRateLimiter, validate({ body: loginSchema }), catchAsync(AuthController.login));
router.post("/google", authRateLimiter, validate({ body: googleSchema }), catchAsync(AuthController.googleLogin));
router.post("/refresh", catchAsync(AuthController.refresh));
router.post("/logout", authenticate, catchAsync(AuthController.logout));
router.post(
  "/forgot-password",
  authRateLimiter,
  validate({ body: forgotPasswordSchema }),
  catchAsync(AuthController.forgotPassword),
);
router.post(
  "/reset-password",
  validate({ body: resetPasswordSchema }),
  catchAsync(AuthController.resetPassword),
);
router.get("/me", authenticate, catchAsync(AuthController.me));

export default router;
