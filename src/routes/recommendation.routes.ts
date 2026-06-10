import { Router } from "express";
import { z } from "zod";
import * as RecommendationController from "../controllers/Recommendation.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema, paginationSchema } from "../validations/common.validation";
import { RULE_CATEGORIES, RULE_MATCH_TYPES } from "../utils/constants";
import { PERMISSIONS as P } from "../utils/permissions";

const ruleSchema = z.object({
  name: z.string().min(2),
  matchType: z.enum(RULE_MATCH_TYPES),
  matchValue: z.string().min(1),
  category: z.enum(RULE_CATEGORIES),
  title: z.string().min(2),
  steps: z.array(z.string()).default([]),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
});

const router = Router();
router.use(authenticate);

router.get("/", requirePermission(P.RULE_READ), validate({ query: paginationSchema }), catchAsync(RecommendationController.listRules));
router.post(
  "/",
  requirePermission(P.RULE_MANAGE),
  validate({ body: ruleSchema }),
  catchAsync(RecommendationController.createRule),
);
router.patch(
  "/:id",
  requirePermission(P.RULE_MANAGE),
  validate({ params: idParamSchema, body: ruleSchema.partial() }),
  catchAsync(RecommendationController.updateRule),
);
router.delete(
  "/:id",
  requirePermission(P.RULE_MANAGE),
  validate({ params: idParamSchema }),
  catchAsync(RecommendationController.deleteRule),
);

export default router;
