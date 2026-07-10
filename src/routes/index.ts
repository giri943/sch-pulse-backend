import { Router } from "express";
import authRoutes from "./auth.routes";
import userRoutes from "./user.routes";
import roleRoutes from "./role.routes";
import channelRoutes from "./channel.routes";
import projectRoutes from "./project.routes";
import monitorRoutes from "./monitor.routes";
import incidentRoutes from "./incident.routes";
import recommendationRoutes from "./recommendation.routes";
import dashboardRoutes from "./dashboard.routes";
import analyticsRoutes from "./analytics.routes";
import auditRoutes from "./audit.routes";
import settingsRoutes from "./settings.routes";

/** Mounts every feature router under /api/v1. */
const router = Router();

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/roles", roleRoutes);
router.use("/channels", channelRoutes);
router.use("/projects", projectRoutes);
router.use("/monitors", monitorRoutes);
router.use("/incidents", incidentRoutes);
router.use("/recommendation-rules", recommendationRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/audit-logs", auditRoutes);
router.use("/settings", settingsRoutes);

export default router;
