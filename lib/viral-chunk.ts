import type { TranscriptSegment } from "./segmenter";

const MAX_WORDS_PER_CHUNK = 3;

/** Hard max characters per viral caption line (one line only). */
export const VIRAL_CAPTION_MAX_CHARS = 18;

/** Per-chunk dwell cap — lower = snappier, then renormalized to the subtitle line window. */
const MAX_CHUNK_SECONDS = 0.24;

export function lineFitsViralCharLimit(joined: string): boolean {
  return joined.length <= VIRAL_CAPTION_MAX_CHARS;
}

/**
 * Split a phrase into one or more lines of at most VIRAL_CAPTION_MAX_CHARS (long single words).
 */
export function splitLongPhraseIntoViralLines(phrase: string): string[] {
  const p = phrase.trim();
  if (p.length === 0) return [];
  if (p.length <= VIRAL_CAPTION_MAX_CHARS) return [p];
  const lines: string[] = [];
  let i = 0;
  while (i < p.length) {
    lines.push(p.slice(i, i + VIRAL_CAPTION_MAX_CHARS));
    i += VIRAL_CAPTION_MAX_CHARS;
  }
  return lines;
}

/**
 * Up to 3 words if the joined line is ≤18 characters; else 2; else 1 (may exceed 18 until split).
 */
export function chunkWordsIntoPhrases(words: string[]): string[] {
  const n = words.length;
  if (n === 0) return [];
  const phrases: string[] = [];
  let i = 0;
  while (i < n) {
    const rem = n - i;
    let take = Math.min(MAX_WORDS_PER_CHUNK, rem);
    while (take >= 1) {
      const slice = words.slice(i, i + take);
      const joined = slice.join(" ");
      if (lineFitsViralCharLimit(joined) || take === 1) {
        phrases.push(joined);
        i += take;
        break;
      }
      take--;
    }
  }
  return phrases;
}

export function enforceNoOverlapStacking(events: TranscriptSegment[]): TranscriptSegment[] {
  if (events.length <= 1) return events;
  const out = [...events];
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    if (cur.start < prev.end) {
      cur.start = prev.end;
    }
    if (cur.end <= cur.start) {
      cur.end = cur.start + 0.03;
    }
  }
  return out;
}

/**
 * Character-weighted timing within each SRT line (longer phrases get more time, closer to speech rhythm),
 * then per-chunk cap + scale so chunks turn over quickly without drifting past the line end.
 * Phrases are split to ≤18 chars per segment; timing is redistributed across those sub-lines.
 */
export function expandSegmentsForViralCaptions(
  segments: TranscriptSegment[]
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];

  for (const seg of segments) {
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const dur = Math.max(0.001, seg.end - seg.start);
    const phrases = chunkWordsIntoPhrases(words);
    const lineText = words.join(" ");
    const totalChars = Math.max(1, lineText.length);

    const proportionalDurs: number[] = [];
    const texts: string[] = [];

    let charPos = 0;
    for (let ci = 0; ci < phrases.length; ci++) {
      const phrase = phrases[ci]!;
      const startChars = charPos;
      charPos += phrase.length;
      if (ci < phrases.length - 1) charPos += 1;

      const t0 = seg.start + dur * (startChars / totalChars);
      const t1 = seg.start + dur * (charPos / totalChars);
      proportionalDurs.push(t1 - t0);
      texts.push(phrase);
    }

    let durs = proportionalDurs.map((d) => Math.min(d, MAX_CHUNK_SECONDS));
    const sum = durs.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      const scale = dur / sum;
      durs = durs.map((d) => d * scale);
    }

    let t = seg.start;
    for (let i = 0; i < phrases.length; i++) {
      const end = i === phrases.length - 1 ? seg.end : t + durs[i]!;
      const phrase = texts[i]!;
      const phraseDur = Math.max(0.001, end - t);
      const viralLines = splitLongPhraseIntoViralLines(phrase);
      const denom = Math.max(1, phrase.length);
      let pt = t;
      for (let li = 0; li < viralLines.length; li++) {
        const line = viralLines[li]!;
        const lineDur = phraseDur * (line.length / denom);
        const lineEnd = li === viralLines.length - 1 ? end : pt + lineDur;
        out.push({
          start: pt,
          end: lineEnd,
          text: line,
        });
        pt = lineEnd;
      }
      t = end;
    }
  }

  return enforceNoOverlapStacking(out);
}
