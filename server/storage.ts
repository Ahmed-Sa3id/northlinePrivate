import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const uploadRoot = path.resolve(process.env.UPLOAD_DIR ?? "uploads");
const storageBackend = process.env.STORAGE_BACKEND ?? "local";
const s3Bucket = process.env.S3_BUCKET;
const s3 =
  storageBackend === "s3" && s3Bucket
    ? new S3Client({
        region: process.env.S3_REGION ?? "us-east-1",
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
        credentials:
          process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
            ? {
                accessKeyId: process.env.S3_ACCESS_KEY_ID,
                secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
              }
            : undefined,
      })
    : null;

function normalizeKey(relKey: string) {
  const normalized = path.posix
    .normalize(relKey.replaceAll("\\", "/"))
    .replace(/^\/+/, "");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  )
    throw new Error("Invalid storage key");
  return normalized;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
) {
  const normalized = normalizeKey(relKey);
  const ext = path.extname(normalized);
  const stem = normalized.slice(0, normalized.length - ext.length);
  const key = `${stem}_${randomUUID().slice(0, 8)}${ext}`;
  if (s3 && s3Bucket) {
    await s3.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ContentDisposition: "inline",
      }),
    );
  } else {
    if (process.env.NODE_ENV === "production")
      throw new Error("S3 storage is required in production");
    const destination = path.join(uploadRoot, key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
  return { key, url: `/files/${encodeURIComponent(key)}` };
}

export async function storageRead(relKey: string) {
  const normalized = normalizeKey(relKey);
  if (s3 && s3Bucket) {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: s3Bucket, Key: normalized }),
    );
    if (!result.Body) throw new Error("Object has no body");
    return Buffer.from(await result.Body.transformToByteArray());
  }
  const destination = path.join(uploadRoot, normalized);
  const root = `${uploadRoot}${path.sep}`;
  if (!destination.startsWith(root)) throw new Error("Invalid storage key");
  return readFile(destination);
}

export function getUploadRoot() {
  return uploadRoot;
}
