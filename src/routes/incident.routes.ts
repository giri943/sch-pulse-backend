import { Router } from "express";
import { z } from "zod";
import * as IncidentController from "../controllers/Incident.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema, paginationSchema } from "../validations/common.validation";
import { PERMISSIONS as P } from "../utils/permissions";

const updateIncidentSchema = z.object({
  rootCauseNotes: z.string().max(5000).optional(),
  resolutionNotes: z.string().max(5000).optional(),
  acknowledge: z.boolean().optional(),
});

const router = Router();
router.use(authenticate);

const canRead = requirePermission(P.INCIDENT_READ_OWN, P.INCIDENT_READ_ALL);
const canUpdate = requirePermission(P.INCIDENT_UPDATE_OWN, P.INCIDENT_UPDATE_ALL);

router.get("/", canRead, validate({ query: paginationSchema }), catchAsync(IncidentController.listIncidents));
router.get("/:id", canRead, validate({ params: idParamSchema }), catchAsync(IncidentController.getIncident));
router.patch(
  "/:id",
  canUpdate,
  validate({ params: idParamSchema, body: updateIncidentSchema }),
  catchAsync(IncidentController.updateIncident),
);
router.post(
  "/:id/resolve",
  canUpdate,
  validate({ params: idParamSchema }),
  catchAsync(IncidentController.resolveIncident),
);

export default router;
