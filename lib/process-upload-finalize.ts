import { NextResponse } from "next/server";
import { getVideoDuration } from "@/lib/ffmpeg";
import { getProcessingBudget } from "@/lib/usage";
import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";
import { logE2E } from "@/lib/e2e-timing";
import type { JobRecord } from "@/lib/types/clip-job";
import {
  computeScanWindowSec,
  MAX_PROCESSING_WINDOW_SEC,
  type LongVideoSegment,
} from "@/lib/scan-window";

async function failJob(rec: JobRecord, error: string): Promise<void> {
  await writeJobRecord(
    patchJobRecord(rec, { status: "failed", error: error.slice(0, 2000) })
  );
}

/**
 * After `uploads/{jobId}.mp4` exists locally: ffprobe, budget, transition to queued.
 * Returns `null` on success (caller should return 202), or an error `NextResponse`.
 */
export async function finalizeJobAfterLocalVideoWritten(params: {
  jobId: string;
  userId: string;
  videoPath: string;
  rec: JobRecord;
  /** When the source is longer than 60 minutes, which 60-minute window to process. */
  longVideoSegment?: LongVideoSegment;
  /** Optional: R2 upload-complete instrumentation only; does not change behavior. */
  onTimingMs?: (
    phase: "getVideoDuration" | "getProcessingBudget",
    ms: number
  ) => void;
}): Promise<NextResponse | null> {
  const { jobId, userId, videoPath, rec, longVideoSegment, onTimingMs } = params;

  let t = performance.now();
  const durationSec = await getVideoDuration(videoPath);
  onTimingMs?.("getVideoDuration", performance.now() - t);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    await failJob(rec, "Could not read video duration. Try another file.");
    return NextResponse.json(
      { error: "Could not read video duration. Try another file." },
      {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  }
  const durationMin = durationSec / 60;

  const window =
    durationSec <= MAX_PROCESSING_WINDOW_SEC
      ? computeScanWindowSec(durationSec, undefined)!
      : computeScanWindowSec(durationSec, longVideoSegment);
  if (window == null) {
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
  const scanStartSec = window!.startSec;
  const scanEndSec = window!.endSec;
  const windowLenSec = scanEndSec - scanStartSec;
  const windowMin = windowLenSec / 60;

  t = performance.now();
  const budget = await getProcessingBudget(userId, windowMin);
  onTimingMs?.("getProcessingBudget", performance.now() - t);
  console.log(`[Usage] User plan: ${budget.usage.plan}`);
  console.log(
    `[Usage] Remaining minutes before job: ${budget.usage.minutesRemaining.toFixed(2)}`
  );
  console.log(`[Usage] Source duration: ${durationMin.toFixed(2)} min`);
  console.log(
    `[Usage] Scan window: ${scanStartSec.toFixed(1)}s–${scanEndSec.toFixed(1)}s (${windowMin.toFixed(2)} min)`
  );
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
    return NextResponse.json(
      { error: "Job state changed; try again." },
      { status: 409, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  await writeJobRecord(
    patchJobRecord(latest, {
      status: "queued",
      scanStartSec,
      scanEndSec,
    })
  );
  logE2E(jobId, "job_enqueued");
  return null;
}

export function successQueuedJsonResponse(jobId: string): NextResponse {
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
}
