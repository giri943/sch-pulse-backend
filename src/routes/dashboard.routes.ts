import { Router } from "express";
import * as DashboardController from "../controllers/Dashboard.controller";
import { authenticate } from "../middlewares/auth";
import { catchAsync } from "../utils/catchAsync";

const router = Router();
router.use(authenticate);

router.get("/", catchAsync(DashboardController.globalStats));
router.get("/uptime", catchAsync(DashboardController.uptimeOverview));
router.get("/incidents/recent", catchAsync(DashboardController.recentIncidents));
router.get("/ssl-expiring", catchAsync(DashboardController.sslExpiring));
router.get("/status-board", catchAsync(DashboardController.statusBoard));

export default router;
