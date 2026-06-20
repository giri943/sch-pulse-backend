import { Router } from "express";
import { z } from "zod";
import * as ProjectController from "../controllers/Project.controller";
import * as Membership from "../controllers/ProjectMembership.controller";
import { authenticate, requirePermission } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { catchAsync } from "../utils/catchAsync";
import { idParamSchema, objectId } from "../validations/common.validation";
import { PERMISSIONS as P } from "../utils/permissions";

const projectBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
});
const requestBody = z.object({ message: z.string().max(500).optional() });
const roleBody = z.object({ role: z.enum(["owner", "editor", "viewer"]).optional() });
const addMemberBody = z.object({ userId: objectId, role: z.enum(["owner", "editor", "viewer"]).optional() });

const router = Router();
router.use(authenticate);

// Anyone who can work with monitors can list/read projects (needed to assign/group them).
const canList = requirePermission(P.PROJECT_READ, P.MONITOR_CREATE, P.MONITOR_READ_OWN, P.MONITOR_READ_ALL);

// ─── single-segment routes BEFORE "/:id" ───
router.get("/discover", catchAsync(Membership.discoverProjects));
router.get("/requests/mine", catchAsync(Membership.myRequests));

// ─── request decisions (request-scoped) ───
router.post("/join-requests/:id/accept", validate({ params: idParamSchema, body: roleBody }), catchAsync(Membership.acceptRequest));
router.post("/join-requests/:id/reject", validate({ params: idParamSchema }), catchAsync(Membership.rejectRequest));
router.delete("/join-requests/:id", validate({ params: idParamSchema }), catchAsync(Membership.cancelRequest));

// ─── project CRUD ───
router.get("/", canList, catchAsync(ProjectController.listProjects));
router.post("/", requirePermission(P.PROJECT_CREATE), validate({ body: projectBody }), catchAsync(ProjectController.createProject));
router.get("/:id", canList, validate({ params: idParamSchema }), catchAsync(ProjectController.getProject));
router.patch(
  "/:id",
  requirePermission(P.PROJECT_UPDATE),
  validate({ params: idParamSchema, body: projectBody.partial() }),
  catchAsync(ProjectController.updateProject),
);
router.delete("/:id", requirePermission(P.PROJECT_DELETE), validate({ params: idParamSchema }), catchAsync(ProjectController.deleteProject));

// ─── join requests (project-scoped) ───
router.post("/:id/join-requests", validate({ params: idParamSchema, body: requestBody }), catchAsync(Membership.requestToJoin));
router.get("/:id/join-requests", validate({ params: idParamSchema }), catchAsync(Membership.listProjectRequests));

// ─── members (owner-managed; checks inside controller) ───
router.get("/:id/members", validate({ params: idParamSchema }), catchAsync(Membership.listMembers));
router.post("/:id/members", validate({ params: idParamSchema, body: addMemberBody }), catchAsync(Membership.addMember));
router.patch("/:id/members/:userId", validate({ params: idParamSchema, body: roleBody }), catchAsync(Membership.updateMemberRole));
router.delete("/:id/members/:userId", validate({ params: idParamSchema }), catchAsync(Membership.removeMember));

export default router;
