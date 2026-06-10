import { Router } from "express";
import { z } from "zod";
import * as ChannelController from "../controllers/Channel.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema } from "../validations/common.validation";
import { PERMISSIONS as P } from "../utils/permissions";

const channelBody = z.object({
  name: z.string().min(2).max(80),
  type: z.enum(["google_chat"]).default("google_chat"),
  webhookUrl: z.string().url(),
  enabled: z.boolean().optional(),
});

const router = Router();
router.use(authenticate);

router.get("/", requirePermission(P.CHANNEL_READ), catchAsync(ChannelController.listChannels));
router.post("/", requirePermission(P.CHANNEL_MANAGE), validate({ body: channelBody }), catchAsync(ChannelController.createChannel));
router.patch(
  "/:id",
  requirePermission(P.CHANNEL_MANAGE),
  validate({ params: idParamSchema, body: channelBody.partial() }),
  catchAsync(ChannelController.updateChannel),
);
router.delete("/:id", requirePermission(P.CHANNEL_MANAGE), validate({ params: idParamSchema }), catchAsync(ChannelController.deleteChannel));
router.post("/:id/test", requirePermission(P.CHANNEL_MANAGE), validate({ params: idParamSchema }), catchAsync(ChannelController.testChannel));

export default router;
