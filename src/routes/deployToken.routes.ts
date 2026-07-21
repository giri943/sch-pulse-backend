import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema } from "../validations/common.validation";
import * as DeployToken from "../controllers/DeployToken.controller";

// Revoke a deploy token by id (create/list live under /projects/:id/deploy-tokens).
const router = Router();
router.use(authenticate);
router.delete("/:id", validate({ params: idParamSchema }), catchAsync(DeployToken.revokeDeployToken));

export default router;
