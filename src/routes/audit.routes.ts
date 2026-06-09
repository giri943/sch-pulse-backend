import { Router } from "express";
import * as AuditController from "../controllers/Audit.controller";
import { authenticate, authorize } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { paginationSchema } from "../validations/common.validation";

const router = Router();
router.use(authenticate, authorize("admin"));

router.get("/", validate({ query: paginationSchema }), catchAsync(AuditController.listAuditLogs));

export default router;
