import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { auth } from "@clerk/nextjs/server";
import { getStorageRoot } from "@/lib/storage-path";
import { hasTranscriptionScript } from "@/lib/persistent-transcribe";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { readJobRecord } from "@/lib/jobStore";
import {
  assertJobSourceExistsInR2,
  downloadJobSourceToFile,
  isR2Configured,
  R2SourceObjectMissingError,
} from "@/lib/r2";
import {
  finalizeJobAfterLocalVideoWritten,
  successQueuedJsonResponse,
} from "@/lib/process-upload-finalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** R2 GET + disk write + ffprobe + budget; transitions job to queued. */
export const maxDuration = 600;

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

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    logClerkAuthDebug("api/process/upload-complete:POST", req, { userId });
    if (!userId) {
      return jsonError("Unauthorized", 401);
    }

    if (!hasTranscriptionScript()) {
      return jsonError(
        "Transcription scripts missing (expected scripts/transcribe_daemon.py or scripts/transcribe.py). Ensure the app is deployed (scripts/ included).",
        500
      );
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
      return jsonError("Job not found", 404);
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

    try {
      await assertJobSourceExistsInR2(jobId);
    } catch (e: unknown) {
      if (e instanceof R2SourceObjectMissingError) {
        return jsonError(
          "Video not found in storage. Complete the R2 PUT upload first, then call upload-complete.",
          400
        );
      }
      console.error("[R2] head/get error:", e);
      return jsonError(
        e instanceof Error ? e.message : "Failed to verify object in R2",
        502
      );
    }

    const ROOT = getStorageRoot();
    const videoPath = path.join(ROOT, "uploads", `${jobId}.mp4`);

    try {
      await downloadJobSourceToFile(jobId, videoPath);
    } catch (e: unknown) {
      console.error("[R2] download to disk error:", e);
      return jsonError(
        e instanceof Error ? e.message : "Failed to copy video from R2 to server",
        502
      );
    }

    const finalize = await finalizeJobAfterLocalVideoWritten({
      jobId,
      userId,
      videoPath,
      rec,
    });
    if (finalize) return finalize;

    return successQueuedJsonResponse(jobId);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to complete upload";
    console.error("Process upload-complete error:", err);
    return jsonError(message, 500);
  }
}
