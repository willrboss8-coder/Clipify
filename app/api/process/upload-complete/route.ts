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

function fmtMs(ms: number): string {
  return ms.toFixed(1);
}

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

    let body: { jobId?: string; longVideoSegment?: string };
    try {
      body = (await req.json()) as { jobId?: string; longVideoSegment?: string };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    let longVideoSegment: "beginning" | "middle" | "end" | undefined;
    const rawSeg = body.longVideoSegment;
    if (
      rawSeg === "beginning" ||
      rawSeg === "middle" ||
      rawSeg === "end"
    ) {
      longVideoSegment = rawSeg;
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

    const t0 = performance.now();
    let headMs = 0;
    let downloadMs = 0;
    let durationMs = 0;
    let budgetMs = 0;

    const tHead = performance.now();
    try {
      await assertJobSourceExistsInR2(jobId);
      headMs = performance.now() - tHead;
    } catch (e: unknown) {
      headMs = performance.now() - tHead;
      console.log(
        `[upload-complete] jobId=${jobId} totalMs=${fmtMs(performance.now() - t0)} headMs=${fmtMs(headMs)} downloadMs=— durationMs=— budgetMs=— note=head_failed`
      );
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

    const tDl = performance.now();
    try {
      await downloadJobSourceToFile(jobId, videoPath);
      downloadMs = performance.now() - tDl;
    } catch (e: unknown) {
      downloadMs = performance.now() - tDl;
      console.log(
        `[upload-complete] jobId=${jobId} totalMs=${fmtMs(performance.now() - t0)} headMs=${fmtMs(headMs)} downloadMs=${fmtMs(downloadMs)} durationMs=— budgetMs=— note=download_failed`
      );
      console.error("[R2] download to disk error:", e);
      return jsonError(
        e instanceof Error ? e.message : "Failed to copy video from R2 to server",
        502
      );
    }

    let finalize: NextResponse | null = null;
    try {
      finalize = await finalizeJobAfterLocalVideoWritten({
        jobId,
        userId,
        videoPath,
        rec,
        longVideoSegment,
        onTimingMs: (phase, ms) => {
          if (phase === "getVideoDuration") durationMs = ms;
          if (phase === "getProcessingBudget") budgetMs = ms;
        },
      });
    } finally {
      console.log(
        `[upload-complete] jobId=${jobId} totalMs=${fmtMs(performance.now() - t0)} headMs=${fmtMs(headMs)} downloadMs=${fmtMs(downloadMs)} durationMs=${fmtMs(durationMs)} budgetMs=${fmtMs(budgetMs)}`
      );
    }

    if (finalize) return finalize;

    return successQueuedJsonResponse(jobId);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to complete upload";
    console.error("Process upload-complete error:", err);
    return jsonError(message, 500);
  }
}
