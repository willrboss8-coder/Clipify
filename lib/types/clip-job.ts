/** Shared shape for process job API responses (server + client). */

export interface Preset {
  minLen: number;
  maxLen: number;
  count: number;
}

export interface ClipResult {
  clipUrl: string;
  srtUrl: string;
  hook: string;
  confidence: number;
  startSec: number;
  endSec: number;
}

export interface ProcessResponse {
  jobId: string;
  preset: Preset;
  clips: ClipResult[];
  message?: string;
  error?: string;
  scanInfo?: {
    partialScan: boolean;
    minutesScanned: number;
    videoDurationMinutes: number;
  };
  usage?: {
    minutesUsed: number;
    minutesLimit: number;
    minutesRemaining: number;
  };
}

export type JobStatus =
  | "awaiting_upload"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

/**
 * Internal pipeline progress (persisted for staged-worker foundation).
 * Not returned by GET /api/jobs/[jobId] — API shape unchanged for clients.
 */
export type JobPipelineStage =
  | "transcribed"
  | "moments_selected"
  | "clips_rendered"
  | "finalized";

export interface JobRecord {
  jobId: string;
  userId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  platform: string;
  goal: string;
  /**
   * Seconds on the source file to scan (set at upload-complete). Omitted for legacy jobs = full file.
   */
  scanStartSec?: number;
  scanEndSec?: number;
  error?: string;
  /** Present when status === "completed" */
  result?: ProcessResponse;
  /** Latest completed pipeline stage while status is processing (or finalized when completed). */
  stage?: JobPipelineStage;
}
