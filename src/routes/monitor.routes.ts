import { Router } from "express";
import * as MonitorController from "../controllers/Monitor.controller";
import { authenticate, authorize } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema, paginationSchema } from "../validations/common.validation";
import { createMonitorSchema, updateMonitorSchema } from "../validations/monitor.validation";

const router = Router();
router.use(authenticate);

router.get("/", validate({ query: paginationSchema }), catchAsync(MonitorController.listMonitors));
router.post(
  "/",
  authorize("admin", "manager"),
  validate({ body: createMonitorSchema }),
  catchAsync(MonitorController.createMonitor),
);
router.get("/:id", validate({ params: idParamSchema }), catchAsync(MonitorController.getMonitor));
router.patch(
  "/:id",
  authorize("admin", "manager"),
  validate({ params: idParamSchema, body: updateMonitorSchema }),
  catchAsync(MonitorController.updateMonitor),
);
router.delete(
  "/:id",
  authorize("admin", "manager"),
  validate({ params: idParamSchema }),
  catchAsync(MonitorController.deleteMonitor),
);
router.post(
  "/:id/pause",
  authorize("admin", "manager"),
  validate({ params: idParamSchema }),
  catchAsync(MonitorController.pauseMonitor),
);
router.post(
  "/:id/resume",
  authorize("admin", "manager"),
  validate({ params: idParamSchema }),
  catchAsync(MonitorController.resumeMonitor),
);
router.post(
  "/:id/run",
  authorize("admin", "manager"),
  validate({ params: idParamSchema }),
  catchAsync(MonitorController.runMonitor),
);
router.post(
  "/:id/test-notification",
  authorize("admin", "manager"),
  validate({ params: idParamSchema }),
  catchAsync(MonitorController.testNotification),
);
router.get(
  "/:id/checks",
  validate({ params: idParamSchema, query: paginationSchema }),
  catchAsync(MonitorController.monitorChecks),
);
router.get(
  "/:id/uptime",
  validate({ params: idParamSchema }),
  catchAsync(MonitorController.monitorUptime),
);
router.get(
  "/:id/summary",
  validate({ params: idParamSchema }),
  catchAsync(MonitorController.monitorSummary),
);

export default router;
