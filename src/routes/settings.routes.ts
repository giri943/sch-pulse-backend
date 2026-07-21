import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import * as Escalation from "../controllers/Escalation.controller";
import * as RcaReminder from "../controllers/RcaReminder.controller";
import * as Maintenance from "../controllers/Maintenance.controller";

const router = Router();

// Org-wide escalation policy (super-admin only; enforced in the controller).
router.get("/escalation", authenticate, catchAsync(Escalation.getEscalationPolicy));
router.put(
  "/escalation",
  authenticate,
  validate({ body: Escalation.escalationUpdateSchema }),
  catchAsync(Escalation.updateEscalationPolicy),
);

// Org-wide RCA-reminder policy (super-admin only; enforced in the controller).
router.get("/rca-reminder", authenticate, catchAsync(RcaReminder.getRcaReminderPolicy));
router.put(
  "/rca-reminder",
  authenticate,
  validate({ body: RcaReminder.rcaReminderUpdateSchema }),
  catchAsync(RcaReminder.updateRcaReminderPolicy),
);

// Org-wide maintenance defaults (super-admin only; enforced in the controller).
router.get("/maintenance", authenticate, catchAsync(Maintenance.getMaintenancePolicy));
router.put(
  "/maintenance",
  authenticate,
  validate({ body: Maintenance.maintenancePolicyUpdateSchema }),
  catchAsync(Maintenance.updateMaintenancePolicy),
);

export default router;
