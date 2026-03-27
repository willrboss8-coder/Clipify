import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { extractAudio, cutClip, getVideoDuration } from "@/lib/ffmpeg";
import { findBestMoments, getPreset, type Transcript } from "@/lib/segmenter";
import { writeSrt } from "@/lib/srt";
import { getProcessingBudget, recordUsage } from "@/lib/usage";
import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";
import { releaseClaim } from "@/lib/jobClaim";
import { normalizeProcessError } from "@/lib/process-job-errors";
import type { ProcessResponse } from "@/lib/types/clip-job";

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

export interface RunProcessJobParams {
  jobId: string;
  userId: string;
  ROOT: string;
  platform: string;
  goal: string;
}

/**
 * Runs the full extract → transcribe → segment → render pipeline.
 * Expects job status "processing" (set by tryClaimJob). Updates job state to completed | failed.
 * Always releases claim.lock in finally when invoked after a successful claim.
 */
export async function runProcessJob(params: RunProcessJobParams): Promise<void> {
  const { jobId, userId, ROOT, platform, goal } = params;

  try {
    const existing = await readJobRecord(jobId);
    if (!existing) {
      console.error(`[Job ${jobId}] Missing job record`);
      return;
    }

    const scriptPath = path.resolve(process.cwd(), "scripts", "transcribe.py");
    if (!existsSync(scriptPath)) {
      const msg = `Transcription script missing at ${scriptPath}`;
      await writeJobRecord(
        patchJobRecord(existing, { status: "failed", error: msg })
      );
      return;
    }

    const uploadsDir = path.join(ROOT, "uploads");
    const jobDir = path.join(ROOT, "jobs", jobId);
    const outputDir = path.join(ROOT, "outputs", jobId);
    const videoPath = path.join(uploadsDir, `${jobId}.mp4`);

    try {
      const durationSec = await getVideoDuration(videoPath);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        throw new Error("Could not read video duration.");
      }
      const durationMin = durationSec / 60;

      const budget = await getProcessingBudget(userId, durationMin);
      if (!budget.allowed) {
        throw new Error(
          budget.blockedMessage ?? "No minutes remaining this month."
        );
      }

      console.log(`[Job ${jobId}] User plan: ${budget.usage.plan}`);
      console.log(
        `[Job ${jobId}] Remaining minutes before job: ${budget.usage.minutesRemaining.toFixed(2)}`
      );
      console.log(`[Job ${jobId}] Video duration: ${durationMin.toFixed(2)} min`);

      const effectiveScanSec = budget.effectiveScanMinutes * 60;
      const extractOpts =
        effectiveScanSec + 0.01 < durationSec
          ? { maxDurationSec: effectiveScanSec }
          : undefined;

      const audioPath = path.join(jobDir, "audio.wav");
      await extractAudio(videoPath, audioPath, extractOpts);

      const transcriptPath = path.join(jobDir, "transcript.json");
      await runPython(scriptPath, [audioPath, transcriptPath]);

      const transcriptRaw = await readFile(transcriptPath, "utf-8");
      let transcript: Transcript;
      try {
        transcript = JSON.parse(transcriptRaw) as Transcript;
      } catch {
        throw new Error("Transcription produced invalid JSON.");
      }

      const preset = getPreset(platform, goal);
      const clips = findBestMoments(transcript, preset);

      let result: ProcessResponse;

      if (clips.length === 0) {
        const updatedUsage = await recordUsage(userId, budget.effectiveScanMinutes);
        result = {
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
        };
      } else {
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

        const updatedUsage = await recordUsage(userId, budget.effectiveScanMinutes);
        console.log(
          `[Job ${jobId}] Remaining minutes after job: ${updatedUsage.minutesRemaining.toFixed(2)}`
        );

        result = {
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
        };
      }

      const latest = await readJobRecord(jobId);
      if (!latest) return;
      await writeJobRecord(
        patchJobRecord(latest, { status: "completed", result })
      );
    } catch (err: unknown) {
      const message = normalizeProcessError(err);
      console.error(`[Job ${jobId}] Process error:`, err);
      const latest = await readJobRecord(jobId);
      if (!latest) return;
      await writeJobRecord(
        patchJobRecord(latest, { status: "failed", error: message })
      );
    }
  } finally {
    await releaseClaim(jobId).catch(() => {});
  }
}
