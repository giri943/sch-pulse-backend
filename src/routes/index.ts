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
import maintenanceRoutes from "./maintenance.routes";
import deployMaintenanceRoutes from "./deployMaintenance.routes";
import deployTokenRoutes from "./deployToken.routes";
import uploadRoutes from "./upload.routes";
import eventsRoutes from "./events.routes";
import notificationRoutes from "./notification.routes";
import sopRoutes from "./sop.routes";

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
// Deploy-token maintenance must be registered BEFORE /maintenance so its
// token-auth handler wins over the JWT-guarded router for /maintenance/deploy.
router.use("/maintenance/deploy", deployMaintenanceRoutes);
router.use("/maintenance", maintenanceRoutes);
router.use("/deploy-tokens", deployTokenRoutes);
router.use("/uploads", uploadRoutes);
router.use("/events", eventsRoutes);
router.use("/notifications", notificationRoutes);
router.use("/sops", sopRoutes);

export default router;
