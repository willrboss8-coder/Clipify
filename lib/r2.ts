import { createWriteStream } from "fs";
import path from "path";
import { mkdir } from "fs/promises";
import { pipeline } from "stream/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Presigned PUT lifetime (seconds). */
const DEFAULT_PUT_EXPIRES_SEC = 3600;

let cachedClient: S3Client | null = null;

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export function isR2Configured(): boolean {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const key = process.env.R2_ACCESS_KEY_ID?.trim();
  const secret = process.env.R2_SECRET_ACCESS_KEY?.trim();
  return Boolean(accountId && bucket && key && secret);
}

/**
 * Object key for the job’s source video in R2 (not the same path as local STORAGE_ROOT uploads).
 * Format: jobs/<jobId>/source.mp4
 */
export function r2SourceObjectKey(jobId: string): string {
  return `jobs/${jobId}/source.mp4`;
}

function getS3ClientForR2(): S3Client {
  if (cachedClient) return cachedClient;
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  cachedClient = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });
  return cachedClient;
}

export interface PresignedPutResult {
  uploadUrl: string;
  key: string;
  bucket: string;
  expiresIn: number;
  contentType: string;
}

/**
 * Generate a presigned PUT URL so the browser can upload directly to R2.
 */
export async function createPresignedPutForJobSource(
  jobId: string
): Promise<PresignedPutResult> {
  const bucket = requireEnv("R2_BUCKET");
  const key = r2SourceObjectKey(jobId);
  const contentType = "video/mp4";

  const client = getS3ClientForR2();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  const expiresIn = DEFAULT_PUT_EXPIRES_SEC;
  const uploadUrl = await getSignedUrl(client, command, { expiresIn });

  return {
    uploadUrl,
    key,
    bucket,
    expiresIn,
    contentType,
  };
}

export class R2SourceObjectMissingError extends Error {
  constructor(message = "Source object not found in R2") {
    super(message);
    this.name = "R2SourceObjectMissingError";
  }
}

/**
 * Verify the presigned-upload object exists (HEAD).
 */
export async function assertJobSourceExistsInR2(jobId: string): Promise<void> {
  const bucket = requireEnv("R2_BUCKET");
  const key = r2SourceObjectKey(jobId);
  const client = getS3ClientForR2();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      err.name === "NotFound" ||
      err.$metadata?.httpStatusCode === 404 ||
      err.name === "NoSuchKey"
    ) {
      throw new R2SourceObjectMissingError();
    }
    throw e;
  }
}

/**
 * Download R2 object to a local path (streaming).
 */
export async function downloadJobSourceToFile(
  jobId: string,
  destPath: string
): Promise<void> {
  const bucket = requireEnv("R2_BUCKET");
  const key = r2SourceObjectKey(jobId);
  const client = getS3ClientForR2();
  const out = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  const body = out.Body;
  if (!body) {
    throw new Error("R2 GetObject returned empty body");
  }
  await mkdir(path.dirname(destPath), { recursive: true });
  const writeStream = createWriteStream(destPath);
  await pipeline(body as NodeJS.ReadableStream, writeStream);
}
