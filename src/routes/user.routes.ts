import { Router } from "express";
import { z } from "zod";
import * as UserController from "../controllers/User.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema, paginationSchema } from "../validations/common.validation";
import { passwordSchema } from "../validations/auth.validation";
import { objectId } from "../validations/common.validation";
import { USER_STATUSES } from "../utils/constants";
import { PERMISSIONS as P } from "../utils/permissions";

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().toLowerCase(),
  // Optional: when omitted, the new user is emailed an invite link to set their
  // own password (or they sign in with Google).
  password: passwordSchema.optional(),
  roleId: objectId,
});
const updateUserSchema = z.object({
  roleId: objectId.optional(),
  status: z.enum(USER_STATUSES).optional(),
});

const router = Router();
router.use(authenticate);

// Anyone who can create a monitor can search users to tag them.
router.get("/search", requirePermission(P.MONITOR_CREATE), catchAsync(UserController.searchUsers));

router.get("/", requirePermission(P.USER_READ), validate({ query: paginationSchema }), catchAsync(UserController.listUsers));
router.post("/", requirePermission(P.USER_CREATE), validate({ body: createUserSchema }), catchAsync(UserController.createUser));
router.patch(
  "/:id",
  requirePermission(P.USER_UPDATE),
  validate({ params: idParamSchema, body: updateUserSchema }),
  catchAsync(UserController.updateUser),
);
const deleteUserSchema = z.object({ transferToUserId: objectId.optional() });
router.delete(
  "/:id",
  requirePermission(P.USER_DELETE),
  validate({ params: idParamSchema, body: deleteUserSchema }),
  catchAsync(UserController.deleteUser),
);

export default router;
