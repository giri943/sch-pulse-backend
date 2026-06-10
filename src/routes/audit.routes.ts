import { Router } from "express";
import * as AuditController from "../controllers/Audit.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { paginationSchema } from "../validations/common.validation";
import { PERMISSIONS as P } from "../utils/permissions";

const router = Router();
router.use(authenticate, requirePermission(P.AUDIT_READ));

router.get("/", validate({ query: paginationSchema }), catchAsync(AuditController.listAuditLogs));

export default router;
