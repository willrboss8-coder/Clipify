import type { TranscriptSegment } from "@/lib/segmenter";
import {
  chunkTimedWordsIntoPhrases,
  enforceNoOverlapStacking,
  segmentWithOptionalHighlight,
  splitLongPhraseIntoViralLines,
} from "@/lib/viral-chunk";
import { cleanTimedWordToken } from "@/lib/viral-text-clean";
import type { TimedWord } from "./types";

/**
 * Build display segments from word-level timestamps: same natural 3→2→1 rules as SRT path,
 * cleaned tokens, one optional highlight per line.
 */
export function buildSegmentsFromTimedWords(timedWords: TimedWord[]): TranscriptSegment[] {
  const words = timedWords
    .map((w) => {
      const cleaned = cleanTimedWordToken(w.text);
      if (cleaned == null) return null;
      return {
        startSec: w.startSec,
        endSec: w.endSec,
        text: cleaned,
      };
    })
    .filter((w): w is { startSec: number; endSec: number; text: string } => w != null);

  if (words.length === 0) return [];

  const chunks = chunkTimedWordsIntoPhrases(words);
  const out: TranscriptSegment[] = [];

  for (const chunk of chunks) {
    const joined = chunk.map((w) => w.text.trim()).join(" ");
    const start = chunk[0]!.startSec;
    const end = chunk[chunk.length - 1]!.endSec;
    const dur = Math.max(0.02, end - start);
    const viralLines = splitLongPhraseIntoViralLines(joined);
    const denom = Math.max(1, joined.length);
    let pt = Math.max(0, start);
    for (let li = 0; li < viralLines.length; li++) {
      const line = viralLines[li]!;
      const lineDur = dur * (line.length / denom);
      const lineEnd =
        li === viralLines.length - 1 ? end : pt + lineDur;
      out.push(
        segmentWithOptionalHighlight(
          pt,
          Math.max(pt + 0.02, lineEnd),
          line
        )
      );
      pt = lineEnd;
    }
  }

  return enforceNoOverlapStacking(out);
}
