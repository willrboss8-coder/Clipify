export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  duration: number;
  segments: TranscriptSegment[];
}

export interface Preset {
  minLen: number;
  maxLen: number;
  count: number;
}

export interface ClipCandidate {
  startSec: number;
  endSec: number;
  hook: string;
  confidence: number;
  segments: TranscriptSegment[];
}

const STRONG_PATTERNS = [
  { pattern: /\?/g, weight: 3 },
  { pattern: /\byou\b|\byour\b/gi, weight: 2 },
  { pattern: /\bmost people\b/gi, weight: 4 },
  { pattern: /\bsecret\b/gi, weight: 5 },
  { pattern: /\bmistake\b/gi, weight: 4 },
  { pattern: /\d+/g, weight: 2 },
  { pattern: /\bnever\b|\balways\b|\beveryone\b|\bnobody\b/gi, weight: 3 },
  { pattern: /\bthe truth\b|\bhuge\b|\binsane\b|\bcrazy\b/gi, weight: 3 },
  { pattern: /\bhack\b|\btip\b|\btrick\b|\bstrategy\b/gi, weight: 3 },
];

function scoreText(text: string): number {
  let score = 0;
  for (const { pattern, weight } of STRONG_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) score += matches.length * weight;
  }
  // Bonus for sentence length (medium sentences work best)
  const words = text.split(/\s+/).length;
  if (words > 10 && words < 60) score += 2;
  return score;
}

function pickHook(segments: TranscriptSegment[]): string {
  let best = segments[0];
  let bestScore = -1;
  for (const seg of segments.slice(0, 5)) {
    const s = scoreText(seg.text);
    if (s > bestScore) {
      bestScore = s;
      best = seg;
    }
  }
  return best.text.trim();
}

function overlaps(a: ClipCandidate, b: ClipCandidate): boolean {
  return a.startSec < b.endSec && b.startSec < a.endSec;
}

export function getPreset(
  platform: string,
  goal: string
): Preset {
  const isReels = platform === "reels";

  if (goal === "viral") {
    return {
      minLen: isReels ? 15 : 15,
      maxLen: isReels ? 20 : 25,
      count: 8,
    };
  }
  if (goal === "monetize") {
    return {
      minLen: isReels ? 50 : 60,
      maxLen: isReels ? 75 : 90,
      count: 3,
    };
  }
  // default: grow / promote
  return {
    minLen: isReels ? 25 : 30,
    maxLen: isReels ? 35 : 45,
    count: 5,
  };
}

export function findBestMoments(
  transcript: Transcript,
  preset: Preset
): ClipCandidate[] {
  const { duration, segments } = transcript;
  if (segments.length === 0) return [];

  const skipStart = 45;
  const skipEnd = Math.max(0, duration - 45);

  // Filter segments within valid range
  const valid = segments.filter(
    (s) => s.start >= skipStart && s.end <= skipEnd
  );
  if (valid.length === 0) return [];

  // Build candidate windows
  const candidates: ClipCandidate[] = [];

  for (let i = 0; i < valid.length; i++) {
    const windowSegs: TranscriptSegment[] = [valid[i]];
    let windowEnd = valid[i].end;

    for (let j = i + 1; j < valid.length; j++) {
      const len = valid[j].end - valid[i].start;
      if (len > preset.maxLen) break;
      windowSegs.push(valid[j]);
      windowEnd = valid[j].end;
    }

    const windowLen = windowEnd - valid[i].start;
    if (windowLen < preset.minLen) continue;
    if (windowLen > preset.maxLen) continue;

    const fullText = windowSegs.map((s) => s.text).join(" ");
    const rawScore = scoreText(fullText);

    // Prefer clips closer to ideal length
    const idealLen = (preset.minLen + preset.maxLen) / 2;
    const lenPenalty = Math.abs(windowLen - idealLen) * 0.1;

    candidates.push({
      startSec: valid[i].start,
      endSec: windowEnd,
      hook: pickHook(windowSegs),
      confidence: Math.max(0, rawScore - lenPenalty),
      segments: [...windowSegs],
    });
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  // Pick top N non-overlapping
  const selected: ClipCandidate[] = [];
  for (const c of candidates) {
    if (selected.length >= preset.count) break;
    if (selected.some((s) => overlaps(s, c))) continue;
    selected.push(c);
  }

  // Normalize confidence to 0-100
  const maxConf = Math.max(...selected.map((c) => c.confidence), 1);
  for (const c of selected) {
    c.confidence = Math.round((c.confidence / maxConf) * 100);
  }

  // Sort by start time for output
  selected.sort((a, b) => a.startSec - b.startSec);

  return selected;
}
