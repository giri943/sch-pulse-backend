import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { catchAsync } from "../utils/catchAsync";
import * as Notification from "../controllers/Notification.controller";

const router = Router();
router.use(authenticate);

router.get("/", catchAsync(Notification.listNotifications));
router.post("/read-all", catchAsync(Notification.markAllRead));
router.patch("/:id/read", catchAsync(Notification.markRead));

export default router;
