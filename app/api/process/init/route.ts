import { NextRequest, NextResponse } from "next/server";
import { mkdir } from "fs/promises";
import path from "path";
import { v4 as uuid } from "uuid";
import { auth } from "@clerk/nextjs/server";
import { getStorageRoot } from "@/lib/storage-path";
import { hasTranscriptionScript } from "@/lib/persistent-transcribe";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { writeJobRecord } from "@/lib/jobStore";
import type { JobRecord } from "@/lib/types/clip-job";
import { logE2E } from "@/lib/e2e-timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fast path: create job dirs + state only; client uploads video via POST /api/process/upload. */
export const maxDuration = 60;

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
    logClerkAuthDebug("api/process/init:POST", req, { userId });
    if (!userId) {
      return jsonError("Unauthorized", 401);
    }

    let body: { platform?: string; goal?: string };
    try {
      body = (await req.json()) as { platform?: string; goal?: string };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const platform = typeof body.platform === "string" ? body.platform : "tiktok";
    const goal = typeof body.goal === "string" ? body.goal : "default";

    const ROOT = getStorageRoot();
    if (!hasTranscriptionScript()) {
      return jsonError(
        "Transcription scripts missing (expected scripts/transcribe_daemon.py or scripts/transcribe.py). Ensure the app is deployed (scripts/ included).",
        500
      );
    }

    const jobId = uuid();
    logE2E(jobId, "request_received");
    const uploadsDir = path.join(ROOT, "uploads");
    const jobDir = path.join(ROOT, "jobs", jobId);
    const outputDir = path.join(ROOT, "outputs", jobId);

    await mkdir(uploadsDir, { recursive: true });
    await mkdir(jobDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const now = new Date().toISOString();
    const record: JobRecord = {
      jobId,
      userId,
      status: "awaiting_upload",
      createdAt: now,
      updatedAt: now,
      platform,
      goal,
    };
    await writeJobRecord(record);

    return NextResponse.json(
      {
        jobId,
        status: "awaiting_upload",
        message:
          "Job created. Upload the video with POST /api/process/upload, then poll GET /api/jobs/[jobId].",
      },
      {
        status: 202,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to create processing job";
    console.error("Process init error:", err);
    return jsonError(message, 500);
  }
}
