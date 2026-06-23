import { Project } from "../models/project.model";

/** Resolve a project's name from its id (for notification context). Undefined if none. */
export async function projectNameOf(projectId: unknown): Promise<string | undefined> {
  if (!projectId) return undefined;
  const p = await Project.findById(projectId).select("name").lean();
  return p?.name ?? undefined;
}
