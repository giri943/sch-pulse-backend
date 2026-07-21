import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";
import { logger } from "../config/logger";

// Credentials come from the standard AWS env vars via the SDK's default chain.
let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: config.aws.region,
      // Don't add the default CRC32 checksum to presigned PUTs — the browser
      // can't compute/send that header, which breaks the direct upload + CORS.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  }
  return client;
}

/** Whether file uploads are configured (a bucket is set). */
export const uploadsEnabled = (): boolean => !!config.s3.bucket;

/** Presigned PUT URL the browser uploads a file directly to (5-minute TTL). */
export function presignPut(key: string, contentType: string): Promise<string> {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: config.s3.bucket!, Key: key, ContentType: contentType }), { expiresIn: 300 });
}

/** Server-side upload (used by the proxied upload path — no browser→S3 CORS needed). */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: config.s3.bucket!, Key: key, Body: body, ContentType: contentType }));
}

/** Delete one object. Never throws — cleanup should not block the primary action. */
export async function deleteObject(key: string): Promise<void> {
  if (!config.s3.bucket) return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  } catch (err) {
    logger.error({ err, key }, "Failed to delete S3 object");
  }
}

/** List all objects under a prefix (paginated). Returns [] when uploads are off. */
export async function listObjects(prefix: string): Promise<{ key: string; lastModified?: Date }[]> {
  if (!config.s3.bucket) return [];
  const out: { key: string; lastModified?: Date }[] = [];
  let token: string | undefined;
  do {
    const res = await s3().send(
      new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const o of res.Contents ?? []) if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Delete many objects in one call (batched by 1000). Never throws. */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (!config.s3.bucket || !keys.length) return;
  try {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000).map((Key) => ({ Key }));
      await s3().send(new DeleteObjectsCommand({ Bucket: config.s3.bucket, Delete: { Objects: batch, Quiet: true } }));
    }
  } catch (err) {
    logger.error({ err, count: keys.length }, "Failed to delete S3 objects");
  }
}

/** Presigned GET URL to view a private object (1-hour TTL). */
export function presignGet(key: string): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: config.s3.bucket!, Key: key }), { expiresIn: 3600 });
}

/** Stable CDN URL for an object, when a CDN is configured (else null). */
export function cdnUrl(key: string): string | null {
  return config.s3.cdnUrl ? `${config.s3.cdnUrl}/${key}` : null;
}

/**
 * Best URL to VIEW an uploaded object: the CDN if configured (stable, cached),
 * otherwise a short-lived presigned GET. Used when serializing stored keys.
 */
export async function viewUrlFor(key: string): Promise<string> {
  return cdnUrl(key) ?? (await presignGet(key));
}
