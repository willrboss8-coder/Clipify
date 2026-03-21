import type { TranscriptSegment } from "@/lib/segmenter";
import {
  enforceNoOverlapStacking,
  lineFitsViralCharLimit,
  splitLongPhraseIntoViralLines,
} from "@/lib/viral-chunk";
import type { TimedWord } from "./types";

const MAX_WORDS = 3;

/**
 * Build display segments from word-level timestamps: up to 3 words if line ≤18 chars; else 2; else 1.
 * Long single words are split into consecutive ≤18-char lines with proportional timing.
 */
export function buildSegmentsFromTimedWords(timedWords: TimedWord[]): TranscriptSegment[] {
  const words = timedWords.filter((w) => w.text.trim().length > 0);
  if (words.length === 0) return [];

  const out: TranscriptSegment[] = [];
  let i = 0;
  while (i < words.length) {
    const rem = words.length - i;
    let take = Math.min(MAX_WORDS, rem);
    while (take >= 1) {
      const slice = words.slice(i, i + take);
      const joined = slice.map((w) => w.text.trim()).join(" ");
      if (lineFitsViralCharLimit(joined) || take === 1) {
        const start = slice[0]!.startSec;
        const end = slice[slice.length - 1]!.endSec;
        const dur = Math.max(0.02, end - start);
        const viralLines = splitLongPhraseIntoViralLines(joined);
        const denom = Math.max(1, joined.length);
        let pt = Math.max(0, start);
        for (let li = 0; li < viralLines.length; li++) {
          const line = viralLines[li]!;
          const lineDur = dur * (line.length / denom);
          const lineEnd =
            li === viralLines.length - 1 ? end : pt + lineDur;
          out.push({
            start: pt,
            end: Math.max(pt + 0.02, lineEnd),
            text: line,
          });
          pt = lineEnd;
        }
        i += take;
        break;
      }
      take--;
    }
  }

  return enforceNoOverlapStacking(out);
}
