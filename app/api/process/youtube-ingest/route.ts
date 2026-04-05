import { NextRequest, NextResponse } from "next/server";
import { unlink } from "fs/promises";
import path from "path";
import { auth } from "@clerk/nextjs/server";
import { getStorageRoot } from "@/lib/storage-path";
import { hasTranscriptionScript } from "@/lib/persistent-transcribe";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";
import {
  finalizeJobAfterLocalVideoWritten,
  successQueuedJsonResponse,
} from "@/lib/process-upload-finalize";
import { localFullSourcePath } from "@/lib/video-source-layout";
import {
  assertYtDlpAvailable,
  downloadYoutubeToFile,
  fetchYoutubeMetadata,
} from "@/lib/youtube-download";
import { isAllowedYoutubeUrl, normalizeYoutubeUrl } from "@/lib/youtube-url";
import { MAX_PROCESSING_WINDOW_SEC } from "@/lib/scan-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long downloads; match upload-complete ceiling where possible. */
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
    logClerkAuthDebug("api/process/youtube-ingest:POST", req, { userId });
    if (!userId) {
      return jsonError("Unauthorized", 401);
    }

    if (!hasTranscriptionScript()) {
      return jsonError(
        "Transcription scripts missing (expected scripts/transcribe_daemon.py or scripts/transcribe.py).",
        500
      );
    }

    let body: {
      jobId?: string;
      youtubeUrl?: string;
      longVideoSegment?: string;
    };
    try {
      body = (await req.json()) as {
        jobId?: string;
        youtubeUrl?: string;
        longVideoSegment?: string;
      };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!jobId || !UUID_RE.test(jobId)) {
      return jsonError("Missing or invalid jobId", 400);
    }

    const rawUrl = typeof body.youtubeUrl === "string" ? body.youtubeUrl : "";
    const youtubeUrl = normalizeYoutubeUrl(rawUrl);
    if (!youtubeUrl || !isAllowedYoutubeUrl(youtubeUrl)) {
      return jsonError(
        "Enter a valid YouTube link (youtube.com or youtu.be).",
        400
      );
    }

    let longVideoSegment: "beginning" | "middle" | "end" | undefined;
    const rawSeg = body.longVideoSegment;
    if (rawSeg === "beginning" || rawSeg === "middle" || rawSeg === "end") {
      longVideoSegment = rawSeg;
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
      await assertYtDlpAvailable();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "yt-dlp is not available";
      return jsonError(msg, 503);
    }

    let durationSec: number;
    try {
      const meta = await fetchYoutubeMetadata(youtubeUrl);
      durationSec = meta.durationSec;
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Could not read video metadata.";
      return jsonError(msg.slice(0, 2000), 400);
    }

    if (
      durationSec > MAX_PROCESSING_WINDOW_SEC &&
      longVideoSegment == null
    ) {
      return NextResponse.json(
        {
          error:
            "Video is longer than 60 minutes. Choose Beginning, Middle, or End to process one 60-minute section.",
          longVideoSegmentRequired: true,
        },
        {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    const ROOT = getStorageRoot();
    const uploadsDir = path.join(ROOT, "uploads");
    const videoPath = localFullSourcePath(uploadsDir, jobId);

    try {
      await downloadYoutubeToFile(youtubeUrl, videoPath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Download failed";
      console.error("[youtube-ingest] download error:", e);
      try {
        await unlink(videoPath);
      } catch {
        /* ignore */
      }
      const latest = await readJobRecord(jobId);
      if (latest) {
        await writeJobRecord(
          patchJobRecord(latest, {
            status: "failed",
            error: msg.slice(0, 2000),
          })
        );
      }
      return jsonError(
        msg.slice(0, 2000) ||
          "Could not download video from YouTube. It may be private, region-blocked, or unavailable.",
        502
      );
    }

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
      err instanceof Error ? err.message : "Failed to ingest YouTube video";
    console.error("youtube-ingest error:", err);
    return jsonError(message, 500);
  }
}
