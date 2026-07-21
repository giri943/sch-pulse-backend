import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import * as Maintenance from "../controllers/Maintenance.controller";

const router = Router();
router.use(authenticate);

router.get("/", catchAsync(Maintenance.listMaintenance));
router.post("/", validate({ body: Maintenance.createMaintenanceSchema }), catchAsync(Maintenance.createMaintenance));
router.delete("/:id", catchAsync(Maintenance.cancelMaintenance));

export default router;
