import { Router } from "express";
import { z } from "zod";
import * as RoleController from "../controllers/Role.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema } from "../validations/common.validation";
import { PERMISSIONS as P } from "../utils/permissions";

const roleBody = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(300).optional(),
  permissions: z.array(z.string()).default([]),
});

const router = Router();
router.use(authenticate);

router.get("/permissions/catalog", requirePermission(P.ROLE_READ), RoleController.permissionCatalog);
router.get("/", requirePermission(P.ROLE_READ), catchAsync(RoleController.listRoles));
router.post("/", requirePermission(P.ROLE_CREATE), validate({ body: roleBody }), catchAsync(RoleController.createRole));
router.patch(
  "/:id",
  requirePermission(P.ROLE_UPDATE),
  validate({ params: idParamSchema, body: roleBody.partial() }),
  catchAsync(RoleController.updateRole),
);
router.delete("/:id", requirePermission(P.ROLE_DELETE), validate({ params: idParamSchema }), catchAsync(RoleController.deleteRole));

export default router;
