import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { readJobRecord } from "@/lib/jobStore";
import {
  createPresignedPutForJobSource,
  isR2Configured,
} from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const maxDuration = 30;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  const safe = message.slice(0, 2000);
  return NextResponse.json(
    { error: safe },
    {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }
  );
}

/**
 * Returns a presigned PUT URL for uploading the job source video directly to Cloudflare R2.
 * Caller must have created the job via POST /api/process/init (status awaiting_upload).
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    logClerkAuthDebug("api/process/upload-url:POST", req, { userId });
    if (!userId) {
      return jsonError("Unauthorized", 401);
    }

    if (!isR2Configured()) {
      return jsonError(
        "Direct-to-storage upload is not configured (set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).",
        503
      );
    }

    let body: { jobId?: string };
    try {
      body = (await req.json()) as { jobId?: string };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!jobId || !UUID_RE.test(jobId)) {
      return jsonError("Missing or invalid jobId", 400);
    }

    const rec = await readJobRecord(jobId);
    if (!rec) {
      return jsonError("Not found", 404);
    }
    if (rec.userId !== userId) {
      return jsonError("Not found", 404);
    }
    if (rec.status !== "awaiting_upload") {
      return jsonError(
        "Job is not waiting for upload (wrong status or upload already completed).",
        409
      );
    }

    let presigned: Awaited<ReturnType<typeof createPresignedPutForJobSource>>;
    try {
      presigned = await createPresignedPutForJobSource(jobId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to sign upload URL";
      console.error("[R2] presign error:", err);
      return jsonError(msg, 500);
    }

    return NextResponse.json(
      {
        jobId,
        uploadUrl: presigned.uploadUrl,
        bucket: presigned.bucket,
        key: presigned.key,
        expiresIn: presigned.expiresIn,
        contentType: presigned.contentType,
        method: "PUT" as const,
        message:
          "PUT the raw video bytes to uploadUrl with Content-Type matching contentType. Then call POST /api/process/upload-complete with { jobId } (or use multipart POST /api/process/upload).",
      },
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to create upload URL";
    console.error("upload-url error:", err);
    return jsonError(message, 500);
  }
}
