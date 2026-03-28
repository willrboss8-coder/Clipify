import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { getVideoDuration } from "@/lib/ffmpeg";
import { getProcessingBudget, type ProcessingBudget } from "@/lib/usage";
import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";
import { releaseClaim } from "@/lib/jobClaim";
import { normalizeProcessError } from "@/lib/process-job-errors";
import type { Transcript } from "@/lib/segmenter";
import {
  runExtractAndTranscribeStage,
  runMomentSelectionStage,
  runClipRenderStage,
  runFinalizeStage,
} from "@/lib/stages";
import {
  createNoopLeaseBackend,
  createFilesystemStageLeaseBackend,
  type StageLeaseBackend,
} from "@/lib/pipeline";

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
 * When true (env CLIP_PIPE_SPLIT_TRANSCRIBE=1), the main worker only runs post-transcribe
 * stages; a separate transcribe worker claims queued jobs and runs extract+transcribe only.
 */
export function isPipelineSplitTranscribe(): boolean {
  const v = process.env.CLIP_PIPE_SPLIT_TRANSCRIBE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

interface PostTranscribeTimings {
  momentSelectionSec: number;
  clip1RenderSec: number;
  clip2RenderSec: number;
  finalSaveSec: number;
}

async function executePostTranscribeStages(params: {
  jobId: string;
  userId: string;
  platform: string;
  goal: string;
  transcript: Transcript;
  budget: ProcessingBudget;
  durationMin: number;
  videoPath: string;
  jobDir: string;
  outputDir: string;
  leaseBackend: StageLeaseBackend;
}): Promise<PostTranscribeTimings> {
  const {
    jobId,
    userId,
    platform,
    goal,
    transcript,
    budget,
    durationMin,
    videoPath,
    jobDir,
    outputDir,
    leaseBackend,
  } = params;

  const momentLease = await leaseBackend.tryAcquire(jobId, "moment_selection");
  if (!momentLease) {
    throw new Error("Could not acquire moment_selection lease.");
  }
  let ms: Awaited<ReturnType<typeof runMomentSelectionStage>>;
  try {
    ms = await runMomentSelectionStage({
      jobId,
      platform,
      goal,
      transcript,
    });
  } finally {
    await momentLease.release();
  }

  const renderLease = await leaseBackend.tryAcquire(jobId, "render");
  if (!renderLease) {
    throw new Error("Could not acquire render lease.");
  }
  let cr: Awaited<ReturnType<typeof runClipRenderStage>>;
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
  } finally {
    await renderLease.release();
  }

  const finalizeLease = await leaseBackend.tryAcquire(jobId, "finalize");
  if (!finalizeLease) {
    throw new Error("Could not acquire finalize lease.");
  }
  let finalSaveSec: number;
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

  return {
    momentSelectionSec: ms.momentSelectionSec,
    clip1RenderSec: cr.clip1RenderSec,
    clip2RenderSec: cr.clip2RenderSec,
    finalSaveSec,
  };
}

/**
 * Transcribe-only worker: claim must already be held (tryClaimJob). Runs extract+transcribe
 * with a filesystem lease; does NOT release claim.lock on success (main worker completes the job).
 */
export async function runTranscribeWorkerJob(
  params: RunProcessJobParams
): Promise<void> {
  const { jobId, userId, ROOT, platform, goal, claimedAtMs } = params;
  const jobStartMs = Date.now();
  let extractSec: number | undefined;
  let transcribeSec: number | undefined;
  let claimToProcessingStartSec: number | undefined;
  const leaseBackend = createFilesystemStageLeaseBackend();
  let transcribeLease: Awaited<
    ReturnType<StageLeaseBackend["tryAcquire"]>
  > | null = null;

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
      await releaseClaim(jobId).catch(() => {});
      return;
    }

    const uploadsDir = path.join(ROOT, "uploads");
    const jobDir = path.join(ROOT, "jobs", jobId);
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

      transcribeLease = await leaseBackend.tryAcquire(jobId, "transcribe");
      if (!transcribeLease) {
        throw new Error("Could not acquire transcribe filesystem lease.");
      }

      const et = await runExtractAndTranscribeStage({
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
    } catch (err: unknown) {
      const message = normalizeProcessError(err);
      console.error(`[Job ${jobId}] Transcribe worker error:`, err);
      const latest = await readJobRecord(jobId);
      if (latest) {
        await writeJobRecord(
          patchJobRecord(latest, { status: "failed", error: message })
        );
      }
      await releaseClaim(jobId).catch(() => {});
    }
  } finally {
    if (transcribeLease) {
      await transcribeLease.release().catch(() => {});
    }
    const totalSec = (Date.now() - jobStartMs) / 1000;
    logPipelineTiming(jobId, {
      totalSec,
      claimToProcessingStartSec,
      extractSec,
      transcribeSec,
    });
  }
}

/**
 * Main worker (split mode): job already claimed and transcribe stage finished; runs moment → render → finalize.
 * Holds lease-moment_selection.lock for the whole post-transcribe pipeline to avoid duplicate main workers.
 * Releases claim.lock when done (success or handled failure).
 */
export async function runProcessJobFromMomentSelection(
  params: RunProcessJobParams
): Promise<void> {
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
  const fsLease = createFilesystemStageLeaseBackend();
  let postTranscribeGate: Awaited<
    ReturnType<StageLeaseBackend["tryAcquire"]>
  > | null = null;
  /** False when we skip because another process holds the post-transcribe gate (claim stays with that run). */
  let shouldReleaseClaimInFinally = true;

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
    const transcriptPath = path.join(jobDir, "transcript.json");

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

      postTranscribeGate = await fsLease.tryAcquire(jobId, "moment_selection");
      if (!postTranscribeGate) {
        shouldReleaseClaimInFinally = false;
        console.log(
          `[Job ${jobId}] Skipping post-transcribe pipeline (another worker holds moment_selection lease)`
        );
        return;
      }

      claimToProcessingStartSec = (Date.now() - claimedAtMs) / 1000;

      const transcriptRaw = await readFile(transcriptPath, "utf-8");
      let transcript: Transcript;
      try {
        transcript = JSON.parse(transcriptRaw) as Transcript;
      } catch {
        throw new Error("Could not read transcript for post-transcribe pipeline.");
      }

      const post = await executePostTranscribeStages({
        jobId,
        userId,
        platform,
        goal,
        transcript,
        budget,
        durationMin,
        videoPath,
        jobDir,
        outputDir,
        leaseBackend,
      });
      momentSelectionSec = post.momentSelectionSec;
      clip1RenderSec = post.clip1RenderSec;
      clip2RenderSec = post.clip2RenderSec;
      finalSaveSec = post.finalSaveSec;
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
    if (postTranscribeGate) {
      await postTranscribeGate.release().catch(() => {});
    }
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
    if (shouldReleaseClaimInFinally) {
      await releaseClaim(jobId).catch(() => {});
    }
  }
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
      let et: Awaited<ReturnType<typeof runExtractAndTranscribeStage>>;
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

      const post = await executePostTranscribeStages({
        jobId,
        userId,
        platform,
        goal,
        transcript: et.result.transcript,
        budget,
        durationMin,
        videoPath,
        jobDir,
        outputDir,
        leaseBackend,
      });
      momentSelectionSec = post.momentSelectionSec;
      clip1RenderSec = post.clip1RenderSec;
      clip2RenderSec = post.clip2RenderSec;
      finalSaveSec = post.finalSaveSec;
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
