import { NextRequest, NextResponse } from "next/server";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { requireAwaitingUploadJob } from "@/lib/r2-multipart-guard";
import {
  createMultipartUploadForJobSource,
  isR2Configured,
} from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

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

export async function POST(req: NextRequest) {
  try {
    let body: { jobId?: string };
    try {
      body = (await req.json()) as { jobId?: string };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    const guard = await requireAwaitingUploadJob(jobId);
    logClerkAuthDebug("api/process/r2-multipart/init:POST", req, {
      userId: guard.ok ? guard.userId : null,
    });

    if (!guard.ok) {
      return jsonError(guard.message, guard.status);
    }

    if (!isR2Configured()) {
      return jsonError(
        "Direct-to-storage upload is not configured (set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).",
        503
      );
    }

    let init: Awaited<ReturnType<typeof createMultipartUploadForJobSource>>;
    try {
      init = await createMultipartUploadForJobSource(jobId);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to start multipart upload";
      console.error("[R2] multipart init error:", err);
      return jsonError(msg, 500);
    }

    return NextResponse.json(
      {
        jobId,
        uploadId: init.uploadId,
        bucket: init.bucket,
        key: init.key,
        chunkSizeBytes: init.chunkSizeBytes,
        message:
          "Upload each part with PUT to URLs from POST /api/process/r2-multipart/part-url, then POST /api/process/r2-multipart/complete before upload-complete.",
      },
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to start multipart upload";
    console.error("r2-multipart/init error:", err);
    return jsonError(message, 500);
  }
}
