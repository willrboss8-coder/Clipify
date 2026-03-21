import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { extractAudio } from "@/lib/ffmpeg";
import { parseSrt } from "@/lib/srt";
import { expandSegmentsForViralCaptions } from "@/lib/viral-chunk";
import type { TranscriptSegment } from "@/lib/segmenter";
import { buildSegmentsFromTimedWords } from "./chunk-timed-words";
import { transcribeClipAudioWithOpenAiWords } from "./openai-whisper-words";
import type { ViralCaptionTimingSource } from "./types";

/**
 * Premium path: OpenAI Whisper word timestamps on clip audio (re-transcribe for timing).
 * Fallback: existing local SRT → chunk/expand pipeline.
 */
export async function resolveViralCaptionSegments(
  videoPath: string,
  srtPath: string
): Promise<{ segments: TranscriptSegment[]; source: ViralCaptionTimingSource }> {
  const provider = (process.env.VIRAL_CAPTION_TIMING_PROVIDER ?? "auto").toLowerCase();

  const tryOpenAi =
    provider !== "local" &&
    (provider === "openai" || provider === "auto") &&
    Boolean(process.env.OPENAI_API_KEY?.trim());

  if (tryOpenAi) {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "viral-cap-"));
    const wavPath = path.join(tmpDir, "clip.wav");
    try {
      await extractAudio(videoPath, wavPath);
      const timedWords = await transcribeClipAudioWithOpenAiWords(wavPath);
      if (timedWords.length > 0) {
        const segments = buildSegmentsFromTimedWords(timedWords);
        if (segments.length > 0) {
          return { segments, source: "openai_whisper" };
        }
      }
    } catch (e) {
      console.warn(
        "[viral-timing] OpenAI word-level path failed; using local SRT:",
        e
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  const srtContent = await readFile(srtPath, "utf-8");
  const segments = parseSrt(srtContent);
  const viralSegments = expandSegmentsForViralCaptions(segments);
  return { segments: viralSegments, source: "local_srt" };
}
