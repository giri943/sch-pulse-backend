import { Router } from "express";
import * as DashboardController from "../controllers/Dashboard.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { catchAsync } from "../utils/catchAsync";
import { PERMISSIONS as P } from "../utils/permissions";

const router = Router();
router.use(authenticate);
// The dashboard only ever exposes monitor-derived data, all scoped to the
// caller's accessible monitors — gate it behind monitor:read like every other router.
router.use(requirePermission(P.MONITOR_READ_OWN, P.MONITOR_READ_ALL));

router.get("/", catchAsync(DashboardController.globalStats));
router.get("/uptime", catchAsync(DashboardController.uptimeOverview));
router.get("/incidents/recent", catchAsync(DashboardController.recentIncidents));
router.get("/ssl-expiring", catchAsync(DashboardController.sslExpiring));
router.get("/domain-expiring", catchAsync(DashboardController.domainExpiring));
router.get("/status-board", catchAsync(DashboardController.statusBoard));

export default router;
