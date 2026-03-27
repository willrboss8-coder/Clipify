import { NextRequest, NextResponse } from "next/server";
import { copyFile, mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { spawn } from "child_process";
import { auth } from "@clerk/nextjs/server";
import { extractAudio, cutClip, getVideoDuration } from "@/lib/ffmpeg";
import { findBestMoments, getPreset, type Transcript } from "@/lib/segmenter";
import { writeSrt } from "@/lib/srt";
import { getProcessingBudget, recordUsage } from "@/lib/usage";
import { getStorageRoot } from "@/lib/storage-path";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Next.js 14 App Router: disable default body size limit
export const maxDuration = 300;

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

function normalizeProcessError(err: unknown): string {
  if (!(err instanceof Error)) {
    return typeof err === "string" ? err : "Unknown error during processing";
  }
  const e = err as NodeJS.ErrnoException;
  const msg = err.message || "";

  if (e.code === "ENOENT") {
    if (/ffmpeg|ffprobe/i.test(msg)) {
      return "ffmpeg or ffprobe is not installed or not on PATH (required on the server).";
    }
    if (/python|python3/i.test(msg)) {
      return "Python was not found. Install python3 or set PYTHON_PATH to the Python that has faster-whisper.";
    }
    return `Missing file or path: ${msg}`;
  }
  if (e.code === "EACCES" || e.code === "EPERM") {
    return "Permission denied writing storage. Check STORAGE_ROOT and filesystem permissions.";
  }
  if (msg.includes("python3 exited") || msg.includes("faster-whisper")) {
    return `Transcription failed: ${msg}`;
  }
  return msg;
}

function pythonExecutable(): string {
  return process.env.PYTHON_PATH?.trim() || "python3";
}

function runPython(
  scriptPath: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExecutable(), [scriptPath, ...args]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`python3 exited ${code}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
    proc.on("error", reject);
  });
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

    // 1. Save uploaded file
    const videoPath = path.join(uploadsDir, `${jobId}.mp4`);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(videoPath, buffer);

    // 1b. Duration + plan budget (cap scan to remaining minutes; block if none left)
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

    const effectiveScanSec = budget.effectiveScanMinutes * 60;
    const extractOpts =
      effectiveScanSec + 0.01 < durationSec
        ? { maxDurationSec: effectiveScanSec }
        : undefined;

    // 2. Extract audio (only first N seconds when plan-capped)
    const audioPath = path.join(jobDir, "audio.wav");
    await extractAudio(videoPath, audioPath, extractOpts);

    // 3. Transcribe
    const transcriptPath = path.join(jobDir, "transcript.json");
    await runPython(scriptPath, [audioPath, transcriptPath]);

    const transcriptRaw = await readFile(transcriptPath, "utf-8");
    let transcript: Transcript;
    try {
      transcript = JSON.parse(transcriptRaw) as Transcript;
    } catch {
      return jsonError("Transcription produced invalid JSON.", 500);
    }

    // 4. Find best moments
    const preset = getPreset(platform, goal);
    const clips = findBestMoments(transcript, preset);

    if (clips.length === 0) {
      const updatedUsage = await recordUsage(userId, budget.effectiveScanMinutes);
      return NextResponse.json({
        jobId,
        preset,
        clips: [],
        message:
          "No strong moments found. The video may be too short or lack engaging content.",
        scanInfo: {
          partialScan: budget.capped,
          minutesScanned: budget.effectiveScanMinutes,
          videoDurationMinutes: durationMin,
        },
        usage: {
          minutesUsed: updatedUsage.minutesUsed,
          minutesLimit: updatedUsage.minutesLimit,
          minutesRemaining: updatedUsage.minutesRemaining,
        },
      });
    }

    // 5 + 6 + 7. Generate clips with captions and optional watermark
    const results = [];
    for (let i = 0; i < Math.min(clips.length, 2); i++) {
      const clip = clips[i];
      const clipNum = i + 1;
      const srtPath = path.join(jobDir, `clip_${clipNum}.srt`);
      const clipPath = path.join(outputDir, `clip_${clipNum}.mp4`);

      await writeSrt(clip.segments, clip.startSec, srtPath);

      const outputSrt = path.join(outputDir, `clip_${clipNum}.srt`);
      await copyFile(srtPath, outputSrt);

      await cutClip(videoPath, clip.startSec, clip.endSec, clipPath);

      results.push({
        clipUrl: `/api/files/outputs/${jobId}/clip_${clipNum}.mp4`,
        srtUrl: `/api/files/outputs/${jobId}/clip_${clipNum}.srt`,
        hook: clip.hook,
        confidence: clip.confidence,
        startSec: clip.startSec,
        endSec: clip.endSec,
      });
    }

    // Record usage for the minutes actually scanned (not full file when capped)
    const updatedUsage = await recordUsage(userId, budget.effectiveScanMinutes);
    console.log(
      `[Usage] Remaining minutes after job: ${updatedUsage.minutesRemaining.toFixed(2)}`
    );

    return NextResponse.json({
      jobId,
      preset,
      clips: results,
      scanInfo: {
        partialScan: budget.capped,
        minutesScanned: budget.effectiveScanMinutes,
        videoDurationMinutes: durationMin,
      },
      usage: {
        minutesUsed: updatedUsage.minutesUsed,
        minutesLimit: updatedUsage.minutesLimit,
        minutesRemaining: updatedUsage.minutesRemaining,
      },
    });
  } catch (err: unknown) {
    const message = normalizeProcessError(err);
    console.error("Process error:", err);
    try {
      return jsonError(message, 500);
    } catch {
      return new NextResponse(
        JSON.stringify({ error: "Internal processing error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }
  }
}
