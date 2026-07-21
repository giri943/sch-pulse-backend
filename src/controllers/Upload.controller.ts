import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../utils/ApiError";
import { uploadsEnabled, presignPut, presignGet, cdnUrl, putObject, deleteObject } from "../services/s3";

const MAX_BYTES = 5 * 1024 * 1024;

// Only images (proof screenshots) — maps content type to a file extension.
const ALLOWED: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const presignUploadSchema = z.object({
  contentType: z.string().min(1),
  filename: z.string().max(200).optional(),
});

/**
 * Issue a presigned PUT URL so the browser uploads directly to S3 (no file bytes
 * through our API). Returns the object key to store as the attachment reference.
 */
export async function presignUpload(req: Request, res: Response): Promise<void> {
  if (!uploadsEnabled()) throw ApiError.badRequest("File uploads are not configured on this server");
  const { contentType } = req.body as z.infer<typeof presignUploadSchema>;
  const ext = ALLOWED[contentType];
  if (!ext) throw ApiError.badRequest("Only PNG, JPG, WEBP or GIF images can be uploaded");

  const key = `proofs/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
  const uploadUrl = await presignPut(key, contentType);
  // viewUrl: a stable CDN URL when configured; else null → the client falls back
  // to the /uploads/view redirect (which presigns on demand).
  res.json({ key, uploadUrl, viewUrl: cdnUrl(key) });
}

/**
 * Proxied upload: the browser POSTs the raw image bytes to our API, which streams
 * them to S3. Avoids the browser→S3 CORS preflight entirely (the browser only
 * talks to our API, which already allows the frontend origin).
 */
export async function directUpload(req: Request, res: Response): Promise<void> {
  if (!uploadsEnabled()) throw ApiError.badRequest("File uploads are not configured on this server");
  const contentType = (req.header("content-type") ?? "").split(";")[0].trim();
  const ext = ALLOWED[contentType];
  if (!ext) throw ApiError.badRequest("Only PNG, JPG, WEBP or GIF images can be uploaded");

  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) throw ApiError.badRequest("Empty upload");
  if (body.length > MAX_BYTES) throw ApiError.badRequest("Image must be under 5 MB");

  const key = `proofs/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
  await putObject(key, body, contentType);
  res.status(201).json({ key, viewUrl: cdnUrl(key) });
}

/**
 * Public, auth-free redirect to a freshly-signed URL for an uploaded object.
 * Used as a stable <img src> for images embedded in notes so they never expire.
 * Restricted to the `proofs/` prefix (keys are unguessable UUIDs).
 */
export async function viewObject(req: Request, res: Response): Promise<void> {
  if (!uploadsEnabled()) throw ApiError.notFound("Not found");
  const key = String(req.query.key ?? "");
  if (!key.startsWith("proofs/") || key.includes("..")) throw ApiError.badRequest("Invalid key");
  const url = await presignGet(key);
  // Allow this asset to be embedded cross-origin (helmet defaults CORP to
  // same-origin, which would block <img> loading it from the frontend origin).
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.redirect(302, url);
}

/** Delete an uploaded object — called when an image is removed from an editor. */
export async function deleteUpload(req: Request, res: Response): Promise<void> {
  const key = String(req.query.key ?? "");
  if (!key.startsWith("proofs/") || key.includes("..")) throw ApiError.badRequest("Invalid key");
  await deleteObject(key); // never throws
  res.json({ ok: true });
}
