import path from "path";
import { copyFile } from "fs/promises";
import { cutClip, getVideoDimensions } from "@/lib/ffmpeg";
import { findBestMoments, getPreset } from "@/lib/segmenter";
import { writeSrt } from "@/lib/srt";
import type { ProcessingBudget } from "@/lib/usage";
import type { ProcessResponse } from "@/lib/types/clip-job";
import { persistPipelineStage } from "@/lib/stages/persist";

/** ProcessResponse fields before usage is applied in finalize. */
export interface ClipRenderStageResult {
  pendingResult: Omit<ProcessResponse, "usage">;
  clip1RenderSec: number;
  clip2RenderSec: number;
}

export async function runClipRenderStage(params: {
  jobId: string;
  videoPath: string;
  jobDir: string;
  outputDir: string;
  preset: ReturnType<typeof getPreset>;
  clips: ReturnType<typeof findBestMoments>;
  budget: ProcessingBudget;
  durationMin: number;
}): Promise<ClipRenderStageResult> {
  const { jobId, videoPath, jobDir, outputDir, preset, clips, budget, durationMin } =
    params;

  if (clips.length === 0) {
    await persistPipelineStage(jobId, "clips_rendered");
    return {
      pendingResult: {
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
      },
      clip1RenderSec: 0,
      clip2RenderSec: 0,
    };
  }

  const results = [];
  let clip1RenderSec = 0;
  let clip2RenderSec = 0;

  const sourceDimensions = await getVideoDimensions(videoPath);

  for (let i = 0; i < Math.min(clips.length, 2); i++) {
    const clip = clips[i];
    const clipNum = i + 1;
    const srtPath = path.join(jobDir, `clip_${clipNum}.srt`);
    const clipPath = path.join(outputDir, `clip_${clipNum}.mp4`);

    await writeSrt(clip.segments, clip.startSec, srtPath);

    const outputSrt = path.join(outputDir, `clip_${clipNum}.srt`);
    await copyFile(srtPath, outputSrt);

    {
      const tCut = performance.now();
      await cutClip(
        videoPath,
        clip.startSec,
        clip.endSec,
        clipPath,
        sourceDimensions
      );
      const dur = (performance.now() - tCut) / 1000;
      if (i === 0) clip1RenderSec = dur;
      else clip2RenderSec = dur;
    }

    results.push({
      clipUrl: `/api/files/outputs/${jobId}/clip_${clipNum}.mp4`,
      srtUrl: `/api/files/outputs/${jobId}/clip_${clipNum}.srt`,
      hook: clip.hook,
      confidence: clip.confidence,
      startSec: clip.startSec,
      endSec: clip.endSec,
    });
  }
  if (clips.length === 1) {
    clip2RenderSec = 0;
  }

  await persistPipelineStage(jobId, "clips_rendered");

  return {
    pendingResult: {
      jobId,
      preset,
      clips: results,
      scanInfo: {
        partialScan: budget.capped,
        minutesScanned: budget.effectiveScanMinutes,
        videoDurationMinutes: durationMin,
      },
    },
    clip1RenderSec,
    clip2RenderSec,
  };
}
