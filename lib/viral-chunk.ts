import type { TranscriptSegment } from "./segmenter";
import { pickHighlightWordIndex } from "./viral-highlight";
import { cleanTranscriptLineForCaptions } from "./viral-text-clean";

const MAX_WORDS_PER_CHUNK = 3;

/** Hard max characters per viral caption line (one line only). */
export const VIRAL_CAPTION_MAX_CHARS = 18;

/** Per-chunk dwell cap — lower = snappier, then renormalized to the subtitle line window. */
const MAX_CHUNK_SECONDS = 0.24;

/**
 * Avoid ending a chunk on a weak word when more speech follows (more natural phrase breaks).
 */
const BAD_CHUNK_ENDINGS = new Set(
  [
    "the",
    "a",
    "an",
    "to",
    "of",
    "in",
    "on",
    "at",
    "for",
    "with",
    "and",
    "or",
    "but",
    "my",
    "your",
    "his",
    "her",
    "its",
    "our",
    "their",
    "this",
    "that",
    "these",
    "those",
    "as",
    "if",
    "i",
    "you",
    "we",
    "they",
    "he",
    "she",
    "it",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "not",
    "no",
    "so",
    "what",
    "how",
    "which",
    "who",
    "when",
    "where",
    "why",
    "can",
    "could",
    "would",
    "should",
    "will",
    "must",
    "very",
    "just",
    "only",
    "also",
    "about",
    "into",
    "from",
    "by",
    "than",
    "then",
    "there",
    "here",
    "any",
    "each",
    "every",
    "some",
    "nor",
    "here's",
    "that's",
    "what's",
    "it's",
    "i'm",
    "we're",
    "they're",
  ].map((w) => w.toLowerCase())
);

function normalizeChunkWord(w: string): string {
  return w
    .replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")
    .replace(/[.,!?…;:]+$/g, "")
    .toLowerCase();
}

function isBadChunkEnding(lastWord: string, hasMoreWords: boolean): boolean {
  if (!hasMoreWords) return false;
  return BAD_CHUNK_ENDINGS.has(normalizeChunkWord(lastWord));
}

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

export interface ViralTimedWordLike {
  text: string;
}

/**
 * Same rules as chunkWordsIntoPhrases, but preserves word objects (for timestamps).
 */
export function chunkTimedWordsIntoPhrases<T extends ViralTimedWordLike>(
  words: T[]
): T[][] {
  const n = words.length;
  if (n === 0) return [];
  const chunks: T[][] = [];
  let i = 0;
  while (i < n) {
    const rem = n - i;
    let take = Math.min(MAX_WORDS_PER_CHUNK, rem);
    let placed = false;
    while (take >= 1) {
      const slice = words.slice(i, i + take);
      const joined = slice.map((w) => w.text.trim()).join(" ");
      if (!lineFitsViralCharLimit(joined) && take > 1) {
        take--;
        continue;
      }
      if (take === 1) {
        chunks.push(slice);
        i += 1;
        placed = true;
        break;
      }
      const last = slice[slice.length - 1]!.text;
      const hasMore = rem > take;
      if (isBadChunkEnding(last, hasMore)) {
        take--;
        continue;
      }
      chunks.push(slice);
      i += take;
      placed = true;
      break;
    }
    if (!placed) {
      chunks.push([words[i]!]);
      i += 1;
    }
  }
  return chunks;
}

/**
 * Up to 3 words if line ≤18 chars; else 2; else 1.
 * Prefers chunk boundaries that don't end on weak trailing words when more words follow.
 */
export function chunkWordsIntoPhrases(words: string[]): string[] {
  const wrapped = words.map((text) => ({ text }));
  return chunkTimedWordsIntoPhrases(wrapped).map((chunk) =>
    chunk.map((w) => w.text).join(" ")
  );
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

function wordsFromCaptionLine(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

export function segmentWithOptionalHighlight(
  start: number,
  end: number,
  text: string
): TranscriptSegment {
  const words = wordsFromCaptionLine(text);
  const hi = pickHighlightWordIndex(words);
  return {
    start,
    end,
    text,
    ...(hi != null ? { highlightWordIndex: hi } : {}),
  };
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
    const cleaned = cleanTranscriptLineForCaptions(seg.text);
    const words = cleaned.split(/\s+/).filter(Boolean);
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
        out.push(
          segmentWithOptionalHighlight(
            pt,
            lineEnd,
            line
          )
        );
        pt = lineEnd;
      }
      t = end;
    }
  }

  return enforceNoOverlapStacking(out);
}
