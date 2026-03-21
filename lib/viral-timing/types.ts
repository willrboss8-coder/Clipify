/**
 * Word-level timing for premium viral captions (API or future diarized sources).
 * `speaker` is optional — reserved for multi-speaker / diarization providers later.
 */
export interface TimedWord {
  text: string;
  startSec: number;
  endSec: number;
  /** Future: AssemblyAI / diarization speaker index */
  speaker?: number;
}

export type ViralCaptionTimingSource = "openai_whisper" | "local_srt";
