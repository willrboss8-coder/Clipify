import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";
import { auth } from "@clerk/nextjs/server";
import { getStorageRoot } from "@/lib/storage-path";
import { hasTranscriptionScript } from "@/lib/persistent-transcribe";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { readJobRecord } from "@/lib/jobStore";
import {
  finalizeJobAfterLocalVideoWritten,
  successQueuedJsonResponse,
} from "@/lib/process-upload-finalize";
import type { LongVideoSegment } from "@/lib/scan-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Multipart upload + ffprobe + budget; transitions job to queued. */
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
    logClerkAuthDebug("api/process/upload:POST", req, { userId });
    if (!userId) {
      return jsonError("Unauthorized", 401);
    }

    if (!hasTranscriptionScript()) {
      return jsonError(
        "Transcription scripts missing (expected scripts/transcribe_daemon.py or scripts/transcribe.py). Ensure the app is deployed (scripts/ included).",
        500
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const jobIdRaw = formData.get("jobId");
    const jobId =
      typeof jobIdRaw === "string" ? jobIdRaw.trim() : "";

    const segRaw = formData.get("longVideoSegment");
    let longVideoSegment: LongVideoSegment | undefined;
    if (
      segRaw === "beginning" ||
      segRaw === "middle" ||
      segRaw === "end"
    ) {
      longVideoSegment = segRaw;
    }

    if (!file) {
      return jsonError("No file uploaded", 400);
    }
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

    const ROOT = getStorageRoot();
    const videoPath = path.join(ROOT, "uploads", `${jobId}.mp4`);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(videoPath, buffer);

    const finalize = await finalizeJobAfterLocalVideoWritten({
      jobId,
      userId,
      videoPath,
      rec,
      longVideoSegment,
    });
    if (finalize) return finalize;

    return successQueuedJsonResponse(jobId);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to upload processing job";
    console.error("Process upload error:", err);
    return jsonError(message, 500);
  }
}
