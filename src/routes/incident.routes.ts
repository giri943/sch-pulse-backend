import { Router } from "express";
import { z } from "zod";
import * as IncidentController from "../controllers/Incident.controller";
import { authenticate, authorize } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema, paginationSchema } from "../validations/common.validation";

const updateIncidentSchema = z.object({
  rootCauseNotes: z.string().max(5000).optional(),
  resolutionNotes: z.string().max(5000).optional(),
  acknowledge: z.boolean().optional(),
});

const router = Router();
router.use(authenticate);

router.get("/", validate({ query: paginationSchema }), catchAsync(IncidentController.listIncidents));
router.get("/:id", validate({ params: idParamSchema }), catchAsync(IncidentController.getIncident));
router.patch(
  "/:id",
  authorize("admin", "manager"),
  validate({ params: idParamSchema, body: updateIncidentSchema }),
  catchAsync(IncidentController.updateIncident),
);
router.post(
  "/:id/resolve",
  authorize("admin", "manager"),
  validate({ params: idParamSchema }),
  catchAsync(IncidentController.resolveIncident),
);

export default router;
