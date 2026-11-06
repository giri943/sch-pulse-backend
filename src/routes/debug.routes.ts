import { Router } from "express";
import * as Debug from "../controllers/Debug.controller";
import { authenticate } from "../middlewares/auth";
import { catchAsync } from "../utils/catchAsync";

// Mounted only outside production (see routes/index.ts). Still behind
// authenticate so a mis-set NODE_ENV can't expose monitor data unauthenticated.
const router = Router();
router.use(authenticate);

router.get("/domain/probe", catchAsync(Debug.probeDomain));
router.get("/domain/tiers", catchAsync(Debug.domainTiers));
router.post("/domain/refresh", catchAsync(Debug.refreshDomains));
router.post("/domain/reset", catchAsync(Debug.resetDomainChecks));

export default router;
