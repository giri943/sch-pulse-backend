import { MaintenanceWindow } from "../models/maintenanceWindow.model";
import { Incident } from "../models/incident.model";
import { SopCompletion } from "../models/sopCompletion.model";
import { logger } from "../config/logger";
import { deleteObjects, listObjects } from "./s3";

/** Extract S3 proof keys embedded in HTML (CDN URLs `…/proofs/…` or `…?key=proofs%2F…`). */
export function keysFromHtml(html?: string | null): string[] {
  const keys = new Set<string>();
  for (const m of (html ?? "").matchAll(/proofs(?:%2F|\/)[^"'&\s)]+/gi)) {
    let k = m[0];
    try {
      k = decodeURIComponent(k);
    } catch {
      /* keep raw */
    }
    k = k.split("?")[0];
    if (k.startsWith("proofs/")) keys.add(k);
  }
  return [...keys];
}

/** Keys a maintenance window references — inline reason images + legacy proofKey. */
export function keysFromWindow(w: { reason?: string | null; proofKey?: string | null }): string[] {
  const keys = new Set<string>(keysFromHtml(w.reason));
  if (w.proofKey) keys.add(w.proofKey);
  return [...keys];
}

/**
 * Delete maintenance windows for the given monitors/projects AND the S3 images
 * they reference. Used by the monitor/project cascade so nothing is orphaned.
 */
export async function purgeMaintenanceFor(opts: { monitorIds?: unknown[]; projectIds?: unknown[] }): Promise<void> {
  const or: Record<string, unknown>[] = [];
  if (opts.monitorIds?.length) or.push({ monitorId: { $in: opts.monitorIds } });
  if (opts.projectIds?.length) or.push({ projectId: { $in: opts.projectIds } });
  if (!or.length) return;

  const windows = await MaintenanceWindow.find({ $or: or }).select("reason proofKey").lean();
  const keys = [...new Set(windows.flatMap((w) => keysFromWindow(w)))];
  await deleteObjects(keys);
  await MaintenanceWindow.deleteMany({ $or: or });
}

/** Delete S3 images referenced by the incident notes of the given monitors. */
export async function purgeIncidentImagesFor(monitorIds: unknown[]): Promise<void> {
  if (!monitorIds.length) return;
  const incidents = await Incident.find({ monitorId: { $in: monitorIds } }).select("rootCauseNotes resolutionNotes").lean();
  const keys = [...new Set(incidents.flatMap((i) => [...keysFromHtml(i.rootCauseNotes), ...keysFromHtml(i.resolutionNotes)]))];
  await deleteObjects(keys);
}

// Grace period so a freshly-uploaded image (form still open, not yet saved)
// is never swept mid-edit.
const ORPHAN_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Delete `proofs/` objects that no record references and that are older than the
 * grace period — catches images uploaded into an editor that was then abandoned
 * without saving. Runs from the hourly lifecycle pass. Never throws.
 */
export async function sweepOrphanProofs(): Promise<void> {
  try {
    const objects = await listObjects("proofs/");
    if (!objects.length) return;
    const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
    const oldEnough = objects.filter((o) => !o.lastModified || o.lastModified.getTime() < cutoff);
    if (!oldEnough.length) return;

    // Everything still referenced by a maintenance window or an incident note.
    const referenced = new Set<string>();
    const windows = await MaintenanceWindow.find({}).select("reason proofKey").lean();
    windows.forEach((w) => keysFromWindow(w).forEach((k) => referenced.add(k)));
    const incidents = await Incident.find({ $or: [{ rootCauseNotes: /proofs/ }, { resolutionNotes: /proofs/ }] })
      .select("rootCauseNotes resolutionNotes")
      .lean();
    incidents.forEach((i) => {
      keysFromHtml(i.rootCauseNotes).forEach((k) => referenced.add(k));
      keysFromHtml(i.resolutionNotes).forEach((k) => referenced.add(k));
    });
    // ...and images embedded in SOP completion notes (inline proof) + legacy proofKey.
    const completions = await SopCompletion.find({ $or: [{ note: /proofs/ }, { proofKey: { $ne: null } }] })
      .select("note proofKey")
      .lean();
    completions.forEach((c) => {
      keysFromHtml(c.note).forEach((k) => referenced.add(k));
      if (c.proofKey) referenced.add(c.proofKey);
    });

    const orphans = oldEnough.filter((o) => !referenced.has(o.key)).map((o) => o.key);
    if (!orphans.length) return;
    await deleteObjects(orphans);
    logger.warn({ count: orphans.length }, "Swept orphaned proof images from S3");
  } catch (err) {
    logger.error({ err }, "Orphan proof sweep failed");
  }
}
