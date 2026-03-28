import { existsSync } from "fs";
import path from "path";
import { getVideoDuration } from "@/lib/ffmpeg";
import { getProcessingBudget } from "@/lib/usage";
import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";
import { releaseClaim } from "@/lib/jobClaim";
import { normalizeProcessError } from "@/lib/process-job-errors";
import {
  runExtractAndTranscribeStage,
  runMomentSelectionStage,
  runClipRenderStage,
  runFinalizeStage,
} from "@/lib/stages";
import { createNoopLeaseBackend } from "@/lib/pipeline";

function logPipelineTiming(
  jobId: string,
  fields: {
    totalSec: number;
    claimToProcessingStartSec?: number;
    extractSec?: number;
    transcribeSec?: number;
    momentSelectionSec?: number;
    clip1RenderSec?: number;
    clip2RenderSec?: number;
    finalSaveSec?: number;
  }
): void {
  const parts: string[] = [
    `jobId=${jobId}`,
    `totalSec=${fields.totalSec.toFixed(3)}`,
  ];
  const add = (k: string, v: number | undefined) => {
    if (v !== undefined) parts.push(`${k}=${v.toFixed(3)}`);
  };
  add("claimToProcessingStartSec", fields.claimToProcessingStartSec);
  add("extractSec", fields.extractSec);
  add("transcribeSec", fields.transcribeSec);
  add("momentSelectionSec", fields.momentSelectionSec);
  add("clip1RenderSec", fields.clip1RenderSec);
  add("clip2RenderSec", fields.clip2RenderSec);
  add("finalSaveSec", fields.finalSaveSec);
  console.log(`[Job ${jobId}] timing ${parts.join(" ")}`);
}

export interface RunProcessJobParams {
  jobId: string;
  userId: string;
  ROOT: string;
  platform: string;
  goal: string;
  /** `Date.now()` when the worker successfully claimed this job (for claim→pipeline delay). */
  claimedAtMs: number;
}

/**
 * Runs the full pipeline using lib/stages/* with per-stage leases (noop on single-box).
 * Expects job status "processing" (set by tryClaimJob). Updates job state to completed | failed.
 * Always releases claim.lock in finally when invoked after a successful claim.
 */
export async function runProcessJob(params: RunProcessJobParams): Promise<void> {
  const { jobId, userId, ROOT, platform, goal, claimedAtMs } = params;
  const jobStartMs = Date.now();
  let claimToProcessingStartSec: number | undefined;
  let extractSec: number | undefined;
  let transcribeSec: number | undefined;
  let momentSelectionSec: number | undefined;
  let clip1RenderSec: number | undefined;
  let clip2RenderSec: number | undefined;
  let finalSaveSec: number | undefined;

  const leaseBackend = createNoopLeaseBackend();

  try {
    const existing = await readJobRecord(jobId);
    if (!existing) {
      console.error(`[Job ${jobId}] Missing job record`);
      return;
    }

    const scriptPath = path.resolve(process.cwd(), "scripts", "transcribe.py");
    if (!existsSync(scriptPath)) {
      const msg = `Transcription script missing at ${scriptPath}`;
      const tSave = performance.now();
      await writeJobRecord(
        patchJobRecord(existing, { status: "failed", error: msg })
      );
      finalSaveSec = (performance.now() - tSave) / 1000;
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
      const transcriptPath = path.join(jobDir, "transcript.json");

      const transcribeLease = await leaseBackend.tryAcquire(jobId, "transcribe");
      if (!transcribeLease) {
        throw new Error("Could not acquire transcribe lease.");
      }
      let et;
      try {
        et = await runExtractAndTranscribeStage({
          jobId,
          scriptPath,
          videoPath,
          audioPath,
          transcriptPath,
          extractOpts,
          claimedAtMs,
        });
        claimToProcessingStartSec = et.claimToProcessingStartSec;
        extractSec = et.result.extractSec;
        transcribeSec = et.result.transcribeSec;
      } finally {
        await transcribeLease.release();
      }

      const momentLease = await leaseBackend.tryAcquire(jobId, "moment_selection");
      if (!momentLease) {
        throw new Error("Could not acquire moment_selection lease.");
      }
      let ms;
      try {
        ms = await runMomentSelectionStage({
          jobId,
          platform,
          goal,
          transcript: et.result.transcript,
        });
        momentSelectionSec = ms.momentSelectionSec;
      } finally {
        await momentLease.release();
      }

      const renderLease = await leaseBackend.tryAcquire(jobId, "render");
      if (!renderLease) {
        throw new Error("Could not acquire render lease.");
      }
      let cr;
      try {
        cr = await runClipRenderStage({
          jobId,
          videoPath,
          jobDir,
          outputDir,
          preset: ms.preset,
          clips: ms.clips,
          budget,
          durationMin,
        });
        clip1RenderSec = cr.clip1RenderSec;
        clip2RenderSec = cr.clip2RenderSec;
      } finally {
        await renderLease.release();
      }

      const finalizeLease = await leaseBackend.tryAcquire(jobId, "finalize");
      if (!finalizeLease) {
        throw new Error("Could not acquire finalize lease.");
      }
      try {
        finalSaveSec = await runFinalizeStage({
          jobId,
          userId,
          budget,
          pendingResult: cr.pendingResult,
        });
      } finally {
        await finalizeLease.release();
      }
    } catch (err: unknown) {
      const message = normalizeProcessError(err);
      console.error(`[Job ${jobId}] Process error:`, err);
      const latest = await readJobRecord(jobId);
      if (!latest) return;
      {
        const tSave = performance.now();
        await writeJobRecord(
          patchJobRecord(latest, { status: "failed", error: message })
        );
        finalSaveSec = (performance.now() - tSave) / 1000;
      }
    }
  } finally {
    const totalSec = (Date.now() - jobStartMs) / 1000;
    logPipelineTiming(jobId, {
      totalSec,
      claimToProcessingStartSec,
      extractSec,
      transcribeSec,
      momentSelectionSec,
      clip1RenderSec,
      clip2RenderSec,
      finalSaveSec,
    });
    await releaseClaim(jobId).catch(() => {});
  }
}
