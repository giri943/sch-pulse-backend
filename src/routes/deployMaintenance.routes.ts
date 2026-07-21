import { Router } from "express";
import { authenticateDeployToken } from "../middlewares/deployToken";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import * as Maintenance from "../controllers/Maintenance.controller";

// CI/CD endpoints — authenticated by the X-Deploy-Token header, not a user JWT.
const router = Router();
router.use(catchAsync(authenticateDeployToken));

router.post("/", validate({ body: Maintenance.deployStartSchema }), catchAsync(Maintenance.startDeployMaintenance));
router.post("/end", catchAsync(Maintenance.endDeployMaintenance));

export default router;
