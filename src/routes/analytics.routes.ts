import { Router } from "express";
import * as AnalyticsController from "../controllers/Analytics.controller";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema } from "../validations/common.validation";

const router = Router();
router.use(authenticate);

router.get(
  "/monitors/:id",
  validate({ params: idParamSchema }),
  catchAsync(AnalyticsController.monitorAnalytics),
);

export default router;
