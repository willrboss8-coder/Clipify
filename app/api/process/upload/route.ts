import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";
import { auth } from "@clerk/nextjs/server";
import { getVideoDuration } from "@/lib/ffmpeg";
import { getProcessingBudget } from "@/lib/usage";
import { getStorageRoot } from "@/lib/storage-path";
import { hasTranscriptionScript } from "@/lib/persistent-transcribe";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";
import type { JobRecord } from "@/lib/types/clip-job";
import { logE2E } from "@/lib/e2e-timing";

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

async function failJob(rec: JobRecord, error: string): Promise<void> {
  await writeJobRecord(
    patchJobRecord(rec, { status: "failed", error: error.slice(0, 2000) })
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

    const durationSec = await getVideoDuration(videoPath);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      await failJob(rec, "Could not read video duration. Try another file.");
      return jsonError("Could not read video duration. Try another file.", 400);
    }
    const durationMin = durationSec / 60;

    const budget = await getProcessingBudget(userId, durationMin);
    console.log(`[Usage] User plan: ${budget.usage.plan}`);
    console.log(
      `[Usage] Remaining minutes before job: ${budget.usage.minutesRemaining.toFixed(2)}`
    );
    console.log(`[Usage] Video duration: ${durationMin.toFixed(2)} min`);
    console.log(
      `[Usage] Scan budget: ${budget.effectiveScanMinutes.toFixed(2)} min (capped=${budget.capped})`
    );

    if (!budget.allowed) {
      await failJob(
        rec,
        budget.blockedMessage ?? "No minutes remaining this month."
      );
      return NextResponse.json(
        {
          error: budget.blockedMessage ?? "No minutes remaining this month.",
          usageLimitError: true,
          usage: {
            minutesUsed: budget.usage.minutesUsed,
            minutesLimit: budget.usage.minutesLimit,
            minutesRemaining: budget.usage.minutesRemaining,
          },
        },
        { status: 403, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    const latest = await readJobRecord(jobId);
    if (!latest || latest.status !== "awaiting_upload") {
      return jsonError("Job state changed; try again.", 409);
    }

    await writeJobRecord(
      patchJobRecord(latest, {
        status: "queued",
      })
    );
    logE2E(jobId, "job_enqueued");

    return NextResponse.json(
      {
        jobId,
        status: "queued",
        message:
          "Job queued. Poll GET /api/jobs/[jobId] until status is completed (processed by background worker).",
      },
      {
        status: 202,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to upload processing job";
    console.error("Process upload error:", err);
    return jsonError(message, 500);
  }
}
