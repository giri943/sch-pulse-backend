import type { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import PDFDocument from "pdfkit";
import { Project } from "../models/project.model";
import { ProjectSop } from "../models/projectSop.model";
import { SopTemplate } from "../models/sopTemplate.model";
import { User } from "../models/user.model";
import { ApiError } from "../utils/ApiError";
import { writeAudit } from "../utils/audit";
import { projectRole } from "../utils/projectAccess";
import { accessibleProjectIds } from "../utils/access";
import { publish } from "../services/realtime";
import { SOP_FREQUENCIES, type SopFrequency } from "../utils/constants";
import { SopCompletion } from "../models/sopCompletion.model";
import { NotificationChannel } from "../models/notificationChannel.model";
import { logger } from "../config/logger";
import { periodKey, periodLabel } from "../utils/sopPeriod";
import { viewUrlFor, deleteObjects, uploadsEnabled } from "../services/s3";
import { sanitizeNoteHtml } from "../utils/sanitizeNotes";
import { keysFromHtml } from "../services/maintenanceCleanup";

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "invalid id");

/** Flatten rich-note HTML to plain text for the (synchronous) PDF renderer. */
function htmlToText(html?: string | null): string {
  if (!html) return "";
  return html
    .replace(/<img[^>]*>/gi, "") // images are surfaced as separate "Proof" links
    .replace(/<\/(p|div|li|h[1-6]|br)\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ── PDF helpers (branded maintenance report) ────────────────────────────────
type Doc = PDFKit.PDFDocument;
type Cell = { text?: string; color?: string; bold?: boolean; links?: { label: string; url: string }[] };
const PDF = { ink: "#1a2233", muted: "#6b7280", faint: "#9ca3af", border: "#e5e7eb", headerBg: "#f4f5f7", up: "#1a7f37", down: "#b00020", link: "#0a66c2", brand: "#6366f1" };

/**
 * Find the Schbang logo for the PDF header. Checks PDF_LOGO_PATH first, then a few
 * conventional locations/extensions under the backend so it's forgiving about where
 * the file was dropped. Returns null (→ drawn fallback) if none exist.
 */
function resolveLogoPath(): string | null {
  const cwd = process.cwd();
  const candidates = [
    process.env.PDF_LOGO_PATH,
    ...["schbang-logo.png", "schbang-logo.jpg", "schbang-logo.jpeg", "logo.png"].flatMap((f) => [
      path.resolve(cwd, "assets", f),
      path.resolve(cwd, "src", "assets", f),
    ]),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const contentRight = (doc: Doc) => doc.page.width - doc.page.margins.right;
const bottomLimit = (doc: Doc) => doc.page.height - 46; // keep clear of the footer

/** Schbang logo (embedded PNG, or a drawn fallback) + "Schbang" wordmark, then client title block. */
function drawBrandHeader(doc: Doc, opts: { clientName: string; subtitle: string; meta: string[] }): void {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const logo = 38; // square logo box

  let hasLogo = false;
  const logoPath = resolveLogoPath();
  if (logoPath) {
    try {
      doc.image(logoPath, left, top, { fit: [logo, logo], align: "center", valign: "center" });
      hasLogo = true;
    } catch (err) {
      logger.warn({ err, logoPath }, "PDF logo found but could not be embedded — using drawn fallback");
    }
  } else {
    logger.warn({ cwd: process.cwd() }, "PDF logo not found (assets/schbang-logo.png) — using drawn fallback");
  }
  if (!hasLogo) {
    // Fallback: a small drawn puzzle mark so the header still reads as branded.
    const s = 8, gap = 2;
    const tiles = ["#38bdf8", "#ef4444", "#8b5cf6", "#22c55e"];
    [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([cx, cy], i) => {
      doc.roundedRect(left + cx * (s + gap), top + cy * (s + gap), s, s, 2).fill(tiles[i]);
    });
  }

  // "Schbang" wordmark, vertically centered against the logo box.
  doc.font("Helvetica-Bold").fontSize(23);
  const wordY = top + (logo - doc.currentLineHeight()) / 2;
  doc.fillColor(PDF.ink).text("Schbang", left + logo + 12, wordY);

  let y = top + logo + 14;
  doc.fillColor(PDF.ink).font("Helvetica-Bold").fontSize(20).text(opts.clientName, left, y);
  doc.fillColor(PDF.muted).font("Helvetica").fontSize(12).text(opts.subtitle);
  opts.meta.forEach((line) => doc.fillColor(PDF.faint).fontSize(9.5).text(line));
  doc.moveDown(0.7);
  y = doc.y;
  doc.moveTo(left, y).lineTo(contentRight(doc), y).lineWidth(1).strokeColor(PDF.border).stroke();
  doc.moveDown(0.9);
  doc.x = left;
}

/** Bordered table with a shaded header row, cell wrapping, and page breaks (header repeats). */
function drawTable(doc: Doc, columns: { label: string; weight: number; align?: "left" | "center" | "right" }[], rows: Cell[][]): void {
  const left = doc.page.margins.left;
  const totalW = contentRight(doc) - left;
  const weightSum = columns.reduce((a, c) => a + c.weight, 0);
  const colW = columns.map((c) => (c.weight / weightSum) * totalW);
  const pad = 6;

  const size = 8.5;
  const lineH = size + 3;

  const renderRow = (cells: Cell[], header: boolean): void => {
    doc.fontSize(size);
    // Header labels are always centered; body cells follow the column's own alignment.
    const alignOf = (i: number) => (header ? "center" : columns[i].align ?? "left");
    const heights = cells.map((c, i) => {
      if (c.links) return c.links.length * lineH; // one line per link
      doc.font(header || c.bold ? "Helvetica-Bold" : "Helvetica");
      return doc.heightOfString(c.text || " ", { width: colW[i] - 2 * pad, align: alignOf(i) });
    });
    const rowH = Math.max(...heights, 13) + 2 * pad;
    if (!header && doc.y + rowH > bottomLimit(doc)) {
      doc.addPage();
      renderRow(columns.map((c) => ({ text: c.label })), true);
    }
    const y0 = doc.y;
    if (header) doc.rect(left, y0, totalW, rowH).fill(PDF.headerBg);
    let x = left;
    cells.forEach((c, i) => {
      const align = alignOf(i);
      const cw = colW[i];
      doc.strokeColor(PDF.border).lineWidth(0.7).rect(x, y0, cw, rowH).stroke();
      if (c.links) {
        doc.font("Helvetica").fontSize(size);
        c.links.forEach((lk, li) =>
          doc.fillColor(PDF.link).text(lk.label, x + pad, y0 + pad + li * lineH, { width: cw - 2 * pad, align, link: lk.url, underline: true }),
        );
      } else {
        doc
          .fillColor(c.color ?? (header ? "#374151" : PDF.ink))
          .font(header || c.bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(size)
          .text(c.text || "", x + pad, y0 + pad, { width: cw - 2 * pad, align });
      }
      x += cw;
    });
    doc.y = y0 + rowH;
    doc.x = left;
  };

  renderRow(columns.map((c) => ({ text: c.label })), true);
  rows.forEach((r) => renderRow(r, false));
}

/**
 * Draw the centered footer at the bottom of the LAST page only. Call after all
 * content, before doc.end(). Writing in the bottom-margin band would normally make
 * PDFKit auto-append a blank page, so we zero the bottom margin for the write.
 */
function drawFooter(doc: Doc, text: string): void {
  const range = doc.bufferedPageRange();
  doc.switchToPage(range.start + range.count - 1);
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0; // prevent the footer write from spilling to a new page
  const left = doc.page.margins.left;
  doc
    .font("Helvetica").fontSize(8).fillColor(PDF.faint)
    .text(text, left, doc.page.height - 34, { width: doc.page.width - left - doc.page.margins.right, align: "center", lineBreak: false });
  doc.page.margins.bottom = savedBottom;
}

async function assertReadable(req: Request, projectId: string): Promise<void> {
  const allowed = await accessibleProjectIds(req.user!);
  if (allowed !== null && !allowed.some((p) => String(p) === projectId)) throw ApiError.forbidden("You don't have access to this project");
}
async function assertWritable(req: Request, projectId: string): Promise<void> {
  const role = await projectRole(req.user!, projectId);
  if (!(role === "owner" || role === "editor" || role === "super")) throw ApiError.forbidden("Only project owners or editors can manage the service log");
}

type Lite = { id: string; name: string; email: string } | null;
const liteOf = (u: unknown): Lite => {
  const o = u as { _id?: unknown; name?: string; email?: string } | null;
  return o?._id ? { id: String(o._id), name: o.name ?? "", email: o.email ?? "" } : null;
};

function serializeSop(s: Record<string, unknown>) {
  return {
    id: String(s._id),
    templateId: s.templateId ? String(s.templateId) : null,
    name: s.name,
    description: s.description ?? "",
    category: s.category ?? "",
    steps: s.steps ?? [],
    frequency: s.frequency,
    active: s.active !== false,
    owner: liteOf(s.ownerId),
  };
}

export const planSchema = z.object({
  enabled: z.boolean().optional(),
  ownerId: objectId.nullable().optional(),
  channels: z.array(objectId).max(20).optional(),
});
export const attachSopSchema = z.object({
  templateId: objectId,
  frequency: z.enum(SOP_FREQUENCIES).optional(),
  ownerId: objectId.nullable().optional(),
});
export const updateProjectSopSchema = z.object({
  frequency: z.enum(SOP_FREQUENCIES).optional(),
  ownerId: objectId.nullable().optional(),
  active: z.boolean().optional(),
});

/** The project's maintenance plan header + its attached SOPs with current-period status. */
export async function getServiceLog(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  await assertReadable(req, projectId);
  const project = await Project.findById(projectId).select("name hasServerMaintenance maintenanceOwnerId channels").populate("maintenanceOwnerId", "name email").lean();
  if (!project) throw ApiError.notFound("Project not found");
  const sops = await ProjectSop.find({ projectId }).sort({ active: -1, name: 1 }).populate("ownerId", "name email").lean();

  // Current period per SOP + whether it's been ticked off.
  const currentKeys = sops.map((s) => periodKey(s.frequency as SopFrequency));
  const completions = await SopCompletion.find({
    projectSopId: { $in: sops.map((s) => s._id) },
  })
    .populate("completedBy", "name")
    .lean();
  const doneMap = new Map<string, (typeof completions)[number]>();
  completions.forEach((c) => doneMap.set(`${String(c.projectSopId)}|${c.periodKey}`, c));

  const items = await Promise.all(
    sops.map(async (s, i) => {
      const key = currentKeys[i];
      const done = doneMap.get(`${String(s._id)}|${key}`);
      return {
        ...serializeSop(s as Record<string, unknown>),
        currentPeriod: {
          key,
          label: periodLabel(s.frequency as SopFrequency, key),
          done: !!done,
          completedBy: done ? liteOf(done.completedBy) : null,
          completedAt: done ? (done as { createdAt?: Date }).createdAt ?? null : null,
          note: done?.note ?? "",
          proofUrl: done?.proofKey && uploadsEnabled() ? await viewUrlFor(done.proofKey) : null,
        },
      };
    }),
  );

  res.json({
    enabled: !!project.hasServerMaintenance,
    owner: liteOf(project.maintenanceOwnerId),
    channels: (project.channels ?? []).map((c) => String(c)),
    sops: items,
  });
}

// Note is rich text (TipTap HTML) with inline proof images; sanitized on save.
export const completeSchema = z.object({ note: z.string().max(50000).optional(), proofKey: z.string().max(500).optional() });

/** Ensure the caller can tick off a SOP: a project owner/editor, or its assigned owner. */
async function assertCanComplete(req: Request, projectId: string, sopOwnerId: unknown): Promise<void> {
  const role = await projectRole(req.user!, projectId);
  if (role === "owner" || role === "editor" || role === "super") return;
  if (sopOwnerId && String(sopOwnerId) === req.user!.id) return;
  const project = await Project.findById(projectId).select("maintenanceOwnerId").lean();
  if (project && String(project.maintenanceOwnerId ?? "") === req.user!.id) return;
  throw ApiError.forbidden("You can't complete this SOP");
}

export async function completeSop(req: Request, res: Response): Promise<void> {
  const { id: projectId, sopId } = req.params;
  const sop = await ProjectSop.findOne({ _id: sopId, projectId }).lean();
  if (!sop) throw ApiError.notFound("SOP not found on this project");
  await assertCanComplete(req, projectId, sop.ownerId);

  const body = req.body as z.infer<typeof completeSchema>;
  const key = periodKey(sop.frequency as SopFrequency);
  // Clean up any images dropped from a re-saved note (edit of an existing tick).
  const prev = await SopCompletion.findOne({ projectSopId: sopId, periodKey: key }).select("note").lean();
  const note = sanitizeNoteHtml(body.note);
  if (prev?.note) {
    const removed = keysFromHtml(prev.note).filter((k) => !keysFromHtml(note).includes(k));
    if (removed.length) await deleteObjects(removed);
  }
  await SopCompletion.findOneAndUpdate(
    { projectSopId: sopId, periodKey: key },
    { $set: { projectId, note, proofKey: body.proofKey ?? null, completedBy: req.user!.id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await writeAudit(req, "project.sop.complete", { targetType: "project", targetId: projectId, metadata: { sop: sop.name, period: key } });
  res.json({ ok: true, periodKey: key });
  publish("projects");
}

export async function uncompleteSop(req: Request, res: Response): Promise<void> {
  const { id: projectId, sopId } = req.params;
  const sop = await ProjectSop.findOne({ _id: sopId, projectId }).lean();
  if (!sop) throw ApiError.notFound("SOP not found on this project");
  await assertCanComplete(req, projectId, sop.ownerId);

  const key = periodKey(sop.frequency as SopFrequency);
  const removed = await SopCompletion.findOneAndDelete({ projectSopId: sopId, periodKey: key });
  if (removed) {
    const keys = [...keysFromHtml(removed.note), ...(removed.proofKey ? [removed.proofKey] : [])];
    if (keys.length) await deleteObjects(keys);
  }
  await writeAudit(req, "project.sop.uncomplete", { targetType: "project", targetId: projectId });
  res.json({ ok: true });
  publish("projects");
}

/** Auto-generated monthly PDF report per client, for AMC decks. */
export async function downloadServiceLogReport(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  await assertReadable(req, projectId);

  const monthParam = String(req.query.month ?? "");
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (/^\d{4}-\d{2}$/.test(monthParam)) {
    const [yy, mm] = monthParam.split("-").map(Number);
    y = yy;
    m = mm - 1;
  }
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  const monthKey = `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthLabel = start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const project = await Project.findById(projectId).select("name maintenanceOwnerId").populate("maintenanceOwnerId", "name email").lean();
  if (!project) throw ApiError.notFound("Project not found");
  const sops = await ProjectSop.find({ projectId }).sort({ name: 1 }).lean();
  const completions = await SopCompletion.find({ projectId, createdAt: { $gte: start, $lt: end } }).populate("completedBy", "name").sort({ createdAt: 1 }).lean();

  const bySop = new Map<string, typeof completions>();
  completions.forEach((c) => {
    const k = String(c.projectSopId);
    (bySop.get(k) ?? bySop.set(k, []).get(k)!).push(c);
  });
  // Resolve proof view URLs up-front (async) so PDF rendering stays synchronous.
  // Proof now lives as inline images inside the rich note; legacy single proofKey still supported.
  const proofUrls = new Map<string, string[]>();
  for (const c of completions) {
    if (!uploadsEnabled()) continue;
    const keys = [...keysFromHtml(c.note), ...(c.proofKey ? [c.proofKey] : [])];
    if (keys.length) proofUrls.set(String(c._id), await Promise.all(keys.map((k) => viewUrlFor(k))));
  }

  const safe = project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}-maintenance-${monthKey}.pdf"`);

  const fmtDateTime = (d?: Date | null) =>
    d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });
  doc.pipe(res);
  const left = doc.page.margins.left;

  drawBrandHeader(doc, {
    clientName: project.name,
    subtitle: `Server Maintenance Report · ${monthLabel}`,
    meta: [`Maintenance owner: ${liteOf(project.maintenanceOwnerId)?.name ?? "Unassigned"}`],
  });

  if (!sops.length) {
    doc.font("Helvetica").fontSize(11).fillColor(PDF.muted).text("No SOPs are configured on this project's maintenance plan.", left);
  } else {
    // One row per completion (log entry); SOPs with nothing logged this month show a
    // single "Not completed" row so the report still surfaces what was missed.
    const rows: Cell[][] = [];
    let sl = 0;
    for (const s of sops) {
      const cs = bySop.get(String(s._id)) ?? [];
      if (!cs.length) {
        sl += 1;
        rows.push([
          { text: String(sl) },
          { text: s.name },
          { text: String(s.frequency), color: PDF.muted },
          { text: "Not completed", color: PDF.down, bold: true },
          { text: "—", color: PDF.faint },
          { text: "—", color: PDF.faint },
          { text: "—", color: PDF.faint },
        ]);
        continue;
      }
      for (const c of cs) {
        sl += 1;
        const by = (c.completedBy as unknown as { name?: string } | null)?.name ?? "—";
        const noteText = htmlToText(c.note);
        const urls = proofUrls.get(String(c._id)) ?? [];
        rows.push([
          { text: String(sl) },
          { text: s.name },
          { text: String(s.frequency), color: PDF.muted },
          { text: noteText || "—", color: noteText ? PDF.ink : PDF.faint },
          urls.length ? { links: urls.map((u, i) => ({ label: urls.length > 1 ? `Proof ${i + 1}` : "View", url: u })) } : { text: "—", color: PDF.faint },
          { text: fmtDateTime((c as { createdAt?: Date }).createdAt) },
          { text: by },
        ]);
      }
    }

    drawTable(
      doc,
      [
        { label: "Sl", weight: 0.45, align: "center" },
        { label: "SOP", weight: 2.0 },
        { label: "Frequency", weight: 1.35, align: "center" },
        { label: "Comment", weight: 2.4 },
        { label: "Proof", weight: 0.9, align: "center" },
        { label: "Completed On", weight: 2.05, align: "center" },
        { label: "Done By", weight: 1.35 },
      ],
      rows,
    );
  }

  drawFooter(doc, `Generated by Schbang Pulse  ·  ${monthLabel}  ·  ${now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
  doc.end();
}

/** Completion history for the project (most recent first) — powers the history view + PDF. */
export async function getServiceLogHistory(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  await assertReadable(req, projectId);
  const sops = await ProjectSop.find({ projectId }).select("name frequency").lean();
  const sopMap = new Map(sops.map((s) => [String(s._id), s]));
  const completions = await SopCompletion.find({ projectId }).sort({ createdAt: -1 }).limit(500).populate("completedBy", "name").lean();
  const items = await Promise.all(
    completions.map(async (c) => {
      const sop = sopMap.get(String(c.projectSopId));
      return {
        id: String(c._id),
        sopName: sop?.name ?? "SOP",
        frequency: sop?.frequency ?? "monthly",
        periodKey: c.periodKey,
        periodLabel: periodLabel((sop?.frequency ?? "monthly") as SopFrequency, c.periodKey),
        completedBy: liteOf(c.completedBy),
        completedAt: (c as { createdAt?: Date }).createdAt ?? null,
        note: c.note ?? "",
        proofUrl: c.proofKey && uploadsEnabled() ? await viewUrlFor(c.proofKey) : null,
      };
    }),
  );
  res.json({ items });
}

export async function updatePlan(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  await assertWritable(req, projectId);
  const body = req.body as z.infer<typeof planSchema>;
  const update: Record<string, unknown> = {};
  if (body.enabled !== undefined) update.hasServerMaintenance = body.enabled;
  if (body.ownerId !== undefined) {
    if (body.ownerId && !(await User.exists({ _id: body.ownerId }))) throw ApiError.badRequest("Invalid owner");
    update.maintenanceOwnerId = body.ownerId;
  }
  if (body.channels !== undefined) {
    const valid = await NotificationChannel.find({ _id: { $in: body.channels } }).select("_id").lean();
    update.channels = valid.map((c) => c._id);
  }
  await Project.findByIdAndUpdate(projectId, { $set: update });
  await writeAudit(req, "project.serviceLog.update", { targetType: "project", targetId: projectId, metadata: update });
  res.json({ ok: true });
  publish("projects");
}

export async function attachSop(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  await assertWritable(req, projectId);
  const body = req.body as z.infer<typeof attachSopSchema>;
  const template = await SopTemplate.findById(body.templateId).lean();
  if (!template) throw ApiError.notFound("SOP not found");

  const sop = await ProjectSop.create({
    projectId,
    templateId: template._id,
    name: template.name, // snapshot — library edits won't rewrite this plan
    description: template.description ?? "",
    category: template.category ?? "",
    steps: template.steps ?? [],
    frequency: body.frequency ?? template.defaultFrequency ?? "monthly",
    ownerId: body.ownerId ?? null,
    createdBy: req.user!.id,
  });
  await writeAudit(req, "project.sop.attach", { targetType: "project", targetId: projectId, metadata: { sop: template.name } });
  const populated = await ProjectSop.findById(sop._id).populate("ownerId", "name email").lean();
  res.status(201).json(serializeSop(populated as Record<string, unknown>));
  publish("projects");
}

export async function updateProjectSop(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  await assertWritable(req, projectId);
  const sop = await ProjectSop.findOneAndUpdate({ _id: req.params.sopId, projectId }, { $set: req.body }, { new: true })
    .populate("ownerId", "name email")
    .lean();
  if (!sop) throw ApiError.notFound("SOP not found on this project");
  await writeAudit(req, "project.sop.update", { targetType: "project", targetId: projectId });
  res.json(serializeSop(sop as Record<string, unknown>));
  publish("projects");
}

export async function detachSop(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id;
  await assertWritable(req, projectId);
  const sop = await ProjectSop.findOneAndDelete({ _id: req.params.sopId, projectId });
  if (!sop) throw ApiError.notFound("SOP not found on this project");
  // Remove its completion history + any uploaded proof images (inline note images + legacy proofKey).
  const completions = await SopCompletion.find({ projectSopId: req.params.sopId }).select("note proofKey").lean();
  const keys = completions.flatMap((c) => [...keysFromHtml(c.note), ...(c.proofKey ? [c.proofKey] : [])]);
  if (keys.length) await deleteObjects(keys);
  await SopCompletion.deleteMany({ projectSopId: req.params.sopId });
  await writeAudit(req, "project.sop.detach", { targetType: "project", targetId: projectId });
  res.status(204).send();
  publish("projects");
}
