import { readFile } from "fs/promises";
import path from "path";
import type { TimedWord } from "./types";

/**
 * OpenAI Whisper word-level transcription (verbose_json).
 * Requires OPENAI_API_KEY — no extra npm dependency (uses fetch).
 */
export async function transcribeClipAudioWithOpenAiWords(
  audioPath: string
): Promise<TimedWord[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const buf = await readFile(audioPath);
  const form = new FormData();
  form.append(
    "file",
    new File([buf], path.basename(audioPath), { type: "audio/wav" })
  );
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
    },
    body: form,
  });

  if (!res.ok) {
    const rawText = await res.text();
    throw new Error(`OpenAI transcription ${res.status}: ${rawText.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    words?: { word: string; start: number; end: number }[];
  };

  const words = data.words ?? [];
  return words
    .map((w) => ({
      text: (w.word ?? "").trim(),
      startSec: w.start,
      endSec: w.end,
    }))
    .filter((w) => w.text.length > 0);
}
