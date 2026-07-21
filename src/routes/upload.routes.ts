import { Router, raw } from "express";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import * as Upload from "../controllers/Upload.controller";

const router = Router();

// Public (no auth) so <img src> works — signs + redirects, proofs/ prefix only.
router.get("/view", catchAsync(Upload.viewObject));

router.use(authenticate);
// Proxied upload: raw image bytes → S3 (no browser→S3 CORS needed).
router.post("/", raw({ type: () => true, limit: "6mb" }), catchAsync(Upload.directUpload));
// Presigned direct-to-S3 upload (kept as an alternative; needs bucket CORS).
router.post("/presign", validate({ body: Upload.presignUploadSchema }), catchAsync(Upload.presignUpload));
// Remove an uploaded image (editor removal / cleanup).
router.delete("/", catchAsync(Upload.deleteUpload));

export default router;

