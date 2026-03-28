import { findBestMoments, getPreset, type Transcript } from "@/lib/segmenter";
import { persistPipelineStage } from "@/lib/stages/persist";

export interface MomentSelectionStageResult {
  preset: ReturnType<typeof getPreset>;
  clips: ReturnType<typeof findBestMoments>;
  momentSelectionSec: number;
}

export async function runMomentSelectionStage(params: {
  jobId: string;
  platform: string;
  goal: string;
  transcript: Transcript;
}): Promise<MomentSelectionStageResult> {
  const { jobId, platform, goal, transcript } = params;

  let preset: ReturnType<typeof getPreset>;
  let clips: ReturnType<typeof findBestMoments>;
  let momentSelectionSec: number;
  {
    const t0 = performance.now();
    preset = getPreset(platform, goal);
    clips = findBestMoments(transcript, preset);
    momentSelectionSec = (performance.now() - t0) / 1000;
  }

  await persistPipelineStage(jobId, "moments_selected");

  return { preset, clips, momentSelectionSec };
}
