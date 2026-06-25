import { Router } from "express";
import { z } from "zod";
import * as MonitorController from "../controllers/Monitor.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema, paginationSchema } from "../validations/common.validation";
import { createMonitorSchema, updateMonitorSchema } from "../validations/monitor.validation";
import { PERMISSIONS as P } from "../utils/permissions";

const restoreSchema = z.object({ expiresAt: z.string().datetime().nullable().optional() });

const router = Router();
router.use(authenticate);

const canRead = requirePermission(P.MONITOR_READ_OWN, P.MONITOR_READ_ALL);
const canUpdate = requirePermission(P.MONITOR_UPDATE_OWN, P.MONITOR_UPDATE_ALL);
const canDelete = requirePermission(P.MONITOR_DELETE_OWN, P.MONITOR_DELETE_ALL);
const canRun = requirePermission(P.MONITOR_RUN_OWN, P.MONITOR_RUN_ALL);

router.get("/", canRead, validate({ query: paginationSchema }), catchAsync(MonitorController.listMonitors));
router.get("/discover", requirePermission(P.MONITOR_CREATE), catchAsync(MonitorController.discoverMonitors));
router.post(
  "/",
  requirePermission(P.MONITOR_CREATE),
  validate({ body: createMonitorSchema }),
  catchAsync(MonitorController.createMonitor),
);
router.get("/:id", canRead, validate({ params: idParamSchema }), catchAsync(MonitorController.getMonitor));
router.patch(
  "/:id",
  canUpdate,
  validate({ params: idParamSchema, body: updateMonitorSchema }),
  catchAsync(MonitorController.updateMonitor),
);
router.delete("/:id", canDelete, validate({ params: idParamSchema }), catchAsync(MonitorController.deleteMonitor));
router.post("/:id/pause", canUpdate, validate({ params: idParamSchema }), catchAsync(MonitorController.pauseMonitor));
router.post("/:id/resume", canUpdate, validate({ params: idParamSchema }), catchAsync(MonitorController.resumeMonitor));
router.post("/:id/run", canRun, validate({ params: idParamSchema }), catchAsync(MonitorController.runMonitor));
router.post("/:id/restore", canUpdate, validate({ params: idParamSchema, body: restoreSchema }), catchAsync(MonitorController.restoreMonitor));
router.post(
  "/:id/join",
  requirePermission(P.MONITOR_CREATE),
  validate({ params: idParamSchema }),
  catchAsync(MonitorController.joinMonitor),
);
router.post(
  "/:id/test-notification",
  canRun,
  validate({ params: idParamSchema }),
  catchAsync(MonitorController.testNotification),
);
router.get(
  "/:id/checks",
  canRead,
  validate({ params: idParamSchema, query: paginationSchema }),
  catchAsync(MonitorController.monitorChecks),
);
router.get("/:id/uptime", canRead, validate({ params: idParamSchema }), catchAsync(MonitorController.monitorUptime));
router.get("/:id/summary", canRead, validate({ params: idParamSchema }), catchAsync(MonitorController.monitorSummary));

export default router;
