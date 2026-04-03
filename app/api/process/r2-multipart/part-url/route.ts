import { NextRequest, NextResponse } from "next/server";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { requireAwaitingUploadJob } from "@/lib/r2-multipart-guard";
import { createPresignedUrlForUploadPart, isR2Configured } from "@/lib/r2";

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
    let body: { jobId?: string; uploadId?: string; partNumber?: number };
    try {
      body = (await req.json()) as {
        jobId?: string;
        uploadId?: string;
        partNumber?: number;
      };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    const uploadId =
      typeof body.uploadId === "string" ? body.uploadId.trim() : "";
    const partNumber =
      typeof body.partNumber === "number" && Number.isFinite(body.partNumber)
        ? Math.floor(body.partNumber)
        : NaN;

    const guard = await requireAwaitingUploadJob(jobId);
    logClerkAuthDebug("api/process/r2-multipart/part-url:POST", req, {
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
    if (!Number.isFinite(partNumber) || partNumber < 1) {
      return jsonError("Invalid partNumber", 400);
    }

    let signed: Awaited<ReturnType<typeof createPresignedUrlForUploadPart>>;
    try {
      signed = await createPresignedUrlForUploadPart(
        jobId,
        uploadId,
        partNumber
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to sign part URL";
      console.error("[R2] multipart part-url error:", err);
      return jsonError(msg, 500);
    }

    return NextResponse.json(
      {
        jobId,
        uploadUrl: signed.uploadUrl,
        partNumber,
        expiresIn: signed.expiresIn,
        method: "PUT" as const,
      },
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to create part URL";
    console.error("r2-multipart/part-url error:", err);
    return jsonError(message, 500);
  }
}
