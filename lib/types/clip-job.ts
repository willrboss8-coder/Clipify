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

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export interface JobRecord {
  jobId: string;
  userId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  platform: string;
  goal: string;
  error?: string;
  /** Present when status === "completed" */
  result?: ProcessResponse;
}
