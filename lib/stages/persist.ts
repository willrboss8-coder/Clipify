import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";
import type { JobPipelineStage } from "@/lib/types/clip-job";

/** Persist completed pipeline stage to disk (foundation for multi-worker handoff). */
export async function persistPipelineStage(
  jobId: string,
  stage: JobPipelineStage
): Promise<void> {
  const latest = await readJobRecord(jobId);
  if (!latest) return;
  await writeJobRecord(patchJobRecord(latest, { stage }));
}
