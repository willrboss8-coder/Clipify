import { NextRequest, NextResponse } from "next/server";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { requireAwaitingUploadJob } from "@/lib/r2-multipart-guard";
import { abortMultipartUploadForJobSource, isR2Configured } from "@/lib/r2";

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
    let body: { jobId?: string; uploadId?: string };
    try {
      body = (await req.json()) as { jobId?: string; uploadId?: string };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    const uploadId =
      typeof body.uploadId === "string" ? body.uploadId.trim() : "";

    const guard = await requireAwaitingUploadJob(jobId);
    logClerkAuthDebug("api/process/r2-multipart/abort:POST", req, {
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

    if (!uploadId) {
      return jsonError("Missing uploadId", 400);
    }

    await abortMultipartUploadForJobSource(jobId, uploadId);

    return NextResponse.json(
      { jobId, ok: true as const },
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to abort multipart upload";
    console.error("r2-multipart/abort error:", err);
    return jsonError(message, 500);
  }
}
