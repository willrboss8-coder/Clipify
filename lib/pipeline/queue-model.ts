import type { JobRecord } from "@/lib/types/clip-job";

/**
 * Which dedicated worker should process this job next.
 * Maps 1:1 to stage modules under lib/stages/ for a future multi-process deployment.
 *
 * Queue representation today: JobRecord.status + JobRecord.stage on disk (state.json).
 * Future: enqueue { jobId, kind } to Redis/SQS when a stage completes.
 */
export type StageWorkerKind =
  | "transcribe"
  | "moment_selection"
  | "render"
  | "finalize";

/**
 * Given the persisted job record, return the next worker kind that should run,
 * or null if no stage work is pending (not claimed, terminal, or inconsistent).
 *
 * Invariants (current single-worker pipeline):
 * - `queued` → null (main worker must claim first; claim sets `processing`)
 * - `processing` + no `stage` yet → transcribe (extract + faster-whisper)
 * - After each stage, `persistPipelineStage` updates `stage` until finalize writes `completed`
 */
export function getNextStageWorkerKind(record: JobRecord): StageWorkerKind | null {
  if (record.status === "failed" || record.status === "completed") {
    return null;
  }
  if (record.status === "awaiting_upload") {
    return null;
  }
  if (record.status === "queued") {
    return null;
  }
  if (record.status !== "processing") {
    return null;
  }
  if (!record.stage) {
    return "transcribe";
  }
  switch (record.stage) {
    case "transcribed":
      return "moment_selection";
    case "moments_selected":
      return "render";
    case "clips_rendered":
      return "finalize";
    case "finalized":
      return null;
    default:
      return null;
  }
}
