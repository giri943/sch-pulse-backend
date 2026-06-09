import { Router } from "express";
import { z } from "zod";
import * as UserController from "../controllers/User.controller";
import { authenticate, authorize } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema, paginationSchema } from "../validations/common.validation";
import { passwordSchema } from "../validations/auth.validation";
import { ROLES, USER_STATUSES } from "../utils/constants";

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().toLowerCase(),
  password: passwordSchema,
  role: z.enum(ROLES).default("viewer"),
});
const updateUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
});

const router = Router();
router.use(authenticate, authorize("admin"));

router.get("/", validate({ query: paginationSchema }), catchAsync(UserController.listUsers));
router.post("/", validate({ body: createUserSchema }), catchAsync(UserController.createUser));
router.patch(
  "/:id",
  validate({ params: idParamSchema, body: updateUserSchema }),
  catchAsync(UserController.updateUser),
);

export default router;
