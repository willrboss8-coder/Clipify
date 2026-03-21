import type { TranscriptSegment } from "./segmenter";

/**
 * Tighter cap = faster pacing after renormalization to the SRT line window.
 */
const MAX_CHUNK_SECONDS = 0.32;

/**
 * Split words into chunks of at most 2 words (avoids lone 1-word tails when possible).
 */
export function chunkWordsIntoPhrases(words: string[]): string[][] {
  const n = words.length;
  if (n === 0) return [];
  const chunks: string[][] = [];
  let i = 0;
  while (i < n) {
    const rem = n - i;
    let take: number;
    if (rem <= 2) {
      take = rem;
    } else if (rem === 3) {
      take = 2;
    } else {
      take = 2;
    }
    chunks.push(words.slice(i, i + take));
    i += take;
  }
  return chunks;
}

function enforceNoOverlapStacking(events: TranscriptSegment[]): TranscriptSegment[] {
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
 * Short phrase chunks + proportional timing with a tight per-chunk cap (renormalized).
 * Overlapping times would stack multiple ASS lines — we enforce strict sequencing.
 */
export function expandSegmentsForViralCaptions(
  segments: TranscriptSegment[]
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];

  for (const seg of segments) {
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const dur = Math.max(0.001, seg.end - seg.start);
    let chunks = chunkWordsIntoPhrases(words);
    if (chunks.length === 1 && chunks[0]!.length >= 2) {
      chunks = chunks[0]!.map((w) => [w]);
    }
    const totalWords = words.length;
    let cumWords = 0;

    const proportionalDurs: number[] = [];
    const texts: string[] = [];

    for (const chunk of chunks) {
      const w0 = cumWords;
      cumWords += chunk.length;
      const t0 = seg.start + dur * (w0 / totalWords);
      const t1 = seg.start + dur * (cumWords / totalWords);
      proportionalDurs.push(t1 - t0);
      texts.push(chunk.join(" "));
    }

    let durs = proportionalDurs.map((d) => Math.min(d, MAX_CHUNK_SECONDS));
    const sum = durs.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      const scale = dur / sum;
      durs = durs.map((d) => d * scale);
    }

    let t = seg.start;
    for (let i = 0; i < chunks.length; i++) {
      const end = i === chunks.length - 1 ? seg.end : t + durs[i]!;
      out.push({
        start: t,
        end: end,
        text: texts[i]!,
      });
      t = end;
    }
  }

  return enforceNoOverlapStacking(out);
}
