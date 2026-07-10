import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import * as Escalation from "../controllers/Escalation.controller";

const router = Router();

// Org-wide escalation policy (super-admin only; enforced in the controller).
router.get("/escalation", authenticate, catchAsync(Escalation.getEscalationPolicy));
router.put(
  "/escalation",
  authenticate,
  validate({ body: Escalation.escalationUpdateSchema }),
  catchAsync(Escalation.updateEscalationPolicy),
);

export default router;
