import { NextResponse } from "next/server";
import { getVideoDuration } from "@/lib/ffmpeg";
import { getProcessingBudget } from "@/lib/usage";
import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";
import { logE2E } from "@/lib/e2e-timing";
import type { JobRecord } from "@/lib/types/clip-job";

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
}): Promise<NextResponse | null> {
  const { jobId, userId, videoPath, rec } = params;

  const durationSec = await getVideoDuration(videoPath);
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
    return NextResponse.json(
      { error: "Job state changed; try again." },
      { status: 409, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  await writeJobRecord(
    patchJobRecord(latest, {
      status: "queued",
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
