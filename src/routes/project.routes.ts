import { Router } from "express";
import { z } from "zod";
import * as ProjectController from "../controllers/Project.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema } from "../validations/common.validation";
import { PERMISSIONS as P } from "../utils/permissions";

const projectBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
});

const router = Router();
router.use(authenticate);

// Anyone who can work with monitors can list projects (needed to assign/group them).
const canList = requirePermission(P.PROJECT_READ, P.MONITOR_CREATE, P.MONITOR_READ_OWN, P.MONITOR_READ_ALL);

router.get("/", canList, catchAsync(ProjectController.listProjects));
router.get("/:id", canList, validate({ params: idParamSchema }), catchAsync(ProjectController.getProject));
router.post("/", requirePermission(P.PROJECT_CREATE), validate({ body: projectBody }), catchAsync(ProjectController.createProject));
router.patch(
  "/:id",
  requirePermission(P.PROJECT_UPDATE),
  validate({ params: idParamSchema, body: projectBody.partial() }),
  catchAsync(ProjectController.updateProject),
);
router.delete("/:id", requirePermission(P.PROJECT_DELETE), validate({ params: idParamSchema }), catchAsync(ProjectController.deleteProject));

export default router;
