import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema } from "../validations/common.validation";
import * as Sop from "../controllers/Sop.controller";

// Central SOP library. Read: any authenticated user (to attach). Write: super-admin (in controller).
const router = Router();
router.use(authenticate);

router.get("/", catchAsync(Sop.listSopTemplates));
router.post("/", validate({ body: Sop.sopTemplateSchema }), catchAsync(Sop.createSopTemplate));
router.patch("/:id", validate({ params: idParamSchema, body: Sop.sopTemplateSchema.partial() }), catchAsync(Sop.updateSopTemplate));
router.delete("/:id", validate({ params: idParamSchema }), catchAsync(Sop.archiveSopTemplate));

export default router;
