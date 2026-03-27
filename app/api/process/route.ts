import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { auth } from "@clerk/nextjs/server";
import { getVideoDuration } from "@/lib/ffmpeg";
import { getProcessingBudget } from "@/lib/usage";
import { getStorageRoot } from "@/lib/storage-path";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { writeJobRecord } from "@/lib/jobStore";
import { runProcessJob } from "@/lib/runProcessJob";
import type { JobRecord } from "@/lib/types/clip-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upload + ffprobe + budget only; heavy work runs in background via runProcessJob. */
export const maxDuration = 120;

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
    logClerkAuthDebug("api/process:POST", req, { userId });
    if (!userId) {
      return jsonError("Unauthorized", 401);
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const platform = (formData.get("platform") as string) || "tiktok";
    const goal = (formData.get("goal") as string) || "default";

    if (!file) {
      return jsonError("No file uploaded", 400);
    }

    const ROOT = getStorageRoot();
    const scriptPath = path.resolve(process.cwd(), "scripts", "transcribe.py");
    if (!existsSync(scriptPath)) {
      return jsonError(
        `Transcription script missing at ${scriptPath}. Ensure the app is deployed (scripts/ included).`,
        500
      );
    }

    const jobId = uuid();
    const uploadsDir = path.join(ROOT, "uploads");
    const jobDir = path.join(ROOT, "jobs", jobId);
    const outputDir = path.join(ROOT, "outputs", jobId);

    await mkdir(uploadsDir, { recursive: true });
    await mkdir(jobDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const videoPath = path.join(uploadsDir, `${jobId}.mp4`);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(videoPath, buffer);

    const durationSec = await getVideoDuration(videoPath);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
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

    const now = new Date().toISOString();
    const record: JobRecord = {
      jobId,
      userId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      platform,
      goal,
    };
    await writeJobRecord(record);

    setImmediate(() => {
      void runProcessJob({
        jobId,
        userId,
        ROOT,
        platform,
        goal,
      }).catch((err) => {
        console.error(`[Job ${jobId}] Unhandled runProcessJob rejection:`, err);
      });
    });

    return NextResponse.json(
      {
        jobId,
        status: "queued",
        message:
          "Processing started. Poll GET /api/jobs/[jobId] until status is completed.",
      },
      {
        status: 202,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to enqueue processing job";
    console.error("Process enqueue error:", err);
    return jsonError(message, 500);
  }
}
