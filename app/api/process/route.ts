import { NextRequest, NextResponse } from "next/server";
import { copyFile, mkdir, writeFile, readFile } from "fs/promises";
import path from "path";
import { v4 as uuid } from "uuid";
import { spawn } from "child_process";
import { auth } from "@clerk/nextjs/server";
import { extractAudio, cutClip, getVideoDuration } from "@/lib/ffmpeg";
import { findBestMoments, getPreset, type Transcript } from "@/lib/segmenter";
import { writeSrt } from "@/lib/srt";
import { canUserProcess, recordUsage } from "@/lib/usage";

export const runtime = "nodejs";

// Next.js 14 App Router: disable default body size limit
export const maxDuration = 300;

const ROOT = path.resolve(process.cwd(), "storage");

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
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const platform = (formData.get("platform") as string) || "tiktok";
    const goal = (formData.get("goal") as string) || "default";

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
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

    // 1b. Check video duration against usage limits
    const durationSec = await getVideoDuration(videoPath);
    const durationMin = durationSec / 60;

    const usageCheck = await canUserProcess(userId, durationMin);
    console.log(`[Usage] User plan: ${usageCheck.usage.plan}`);
    console.log(`[Usage] Remaining minutes before job: ${Math.round(usageCheck.usage.minutesRemaining)}`);
    console.log(`[Usage] Video duration: ${durationMin.toFixed(1)} min`);

    if (!usageCheck.allowed) {
      return NextResponse.json(
        { error: usageCheck.message, usageLimitError: true },
        { status: 403 }
      );
    }

    // 2. Extract audio
    const audioPath = path.join(jobDir, "audio.wav");
    await extractAudio(videoPath, audioPath);

    // 3. Transcribe
    const transcriptPath = path.join(jobDir, "transcript.json");
    const scriptPath = path.resolve(process.cwd(), "scripts", "transcribe.py");
    await runPython(scriptPath, [audioPath, transcriptPath]);

    const transcriptRaw = await readFile(transcriptPath, "utf-8");
    const transcript: Transcript = JSON.parse(transcriptRaw);

    // 4. Find best moments
    const preset = getPreset(platform, goal);
    const clips = findBestMoments(transcript, preset);

    if (clips.length === 0) {
      return NextResponse.json({
        jobId,
        preset,
        clips: [],
        message:
          "No strong moments found. The video may be too short or lack engaging content.",
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

      await cutClip(
        videoPath,
        clip.startSec,
        clip.endSec,
        clipPath
      );

      results.push({
        clipUrl: `/api/files/outputs/${jobId}/clip_${clipNum}.mp4`,
        srtUrl: `/api/files/outputs/${jobId}/clip_${clipNum}.srt`,
        hook: clip.hook,
        confidence: clip.confidence,
        startSec: clip.startSec,
        endSec: clip.endSec,
      });
    }

    // Record usage after successful processing
    const updatedUsage = await recordUsage(userId, durationMin);
    console.log(`[Usage] Remaining minutes after job: ${Math.round(updatedUsage.minutesRemaining)}`);

    return NextResponse.json({
      jobId,
      preset,
      clips: results,
      usage: {
        minutesUsed: updatedUsage.minutesUsed,
        minutesLimit: updatedUsage.minutesLimit,
        minutesRemaining: updatedUsage.minutesRemaining,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Process error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
