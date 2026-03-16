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

const INTRO_PATTERNS: RegExp[] = [
  /\bwelcome back\b/i,
  /\bwelcome to the (podcast|show|channel|stream)\b/i,
  /\bin today'?s episode\b/i,
  /\btoday we'?re (talking|going to talk|gonna talk|discussing)\b/i,
  /\bbefore we (get started|begin|dive in|jump in)\b/i,
  /\blet'?s get into it\b/i,
  /\bthanks for tuning in\b/i,
  /\bif you'?re new here\b/i,
  /\bwhat'?s (up|going on) (everybody|everyone|guys)\b/i,
  /\bhey (everybody|everyone|guys)\b/i,
  /\bwhat is up\b/i,
];

const OUTRO_PATTERNS: RegExp[] = [
  /\bthanks for (watching|listening|viewing)\b/i,
  /\bsee you (next time|in the next|later)\b/i,
  /\bsee you in the next one\b/i,
  /\blike and subscribe\b/i,
  /\b(hit|smash) (the )?(like|subscribe|bell|notification)\b/i,
  /\bsubscribe\b/i,
  /\bfollow for more\b/i,
  /\bcheck the link (below|in the description)\b/i,
  /\bthat'?s it for today\b/i,
  /\bcatch you next time\b/i,
  /\bpeace out\b/i,
  /\bgoodbye\b/i,
  /\btake care\b/i,
  /\buntil next time\b/i,
  /\bwrap(ping)? (it )?up\b/i,
];

const AD_PROMO_PATTERNS: RegExp[] = [
  /\b(this|today'?s) (episode|video|show) is (sponsored|brought to you) by\b/i,
  /\bsponsored by\b/i,
  /\bsponsor\b/i,
  /\btoday'?s sponsor\b/i,
  /\ba quick word from our sponsor\b/i,
  /\bad break\b/i,
  /\buse (my |the )?code\b/i,
  /\bpromo code\b/i,
  /\blink in (bio|the description|my bio)\b/i,
  /\blink below\b/i,
  /\bsign up now\b/i,
  /\bfree trial\b/i,
  /\bdownload now\b/i,
  /\bcheck (it )?out\b/i,
  /\bbrought to you by\b/i,
  /\bdiscount code\b/i,
  /\bgo to .+\.com\b/i,
  /\baffiliate\b/i,
];

interface ContentPenalty {
  penalty: number;
  reasons: string[];
}

function classifyContent(
  text: string,
  startSec: number,
  endSec: number,
  duration: number,
  isViral: boolean
): ContentPenalty {
  const reasons: string[] = [];
  let penalty = 0;
  const lower = text.toLowerCase();

  for (const pat of INTRO_PATTERNS) {
    if (pat.test(lower)) {
      penalty += 50;
      reasons.push("intro");
      break;
    }
  }

  for (const pat of OUTRO_PATTERNS) {
    if (pat.test(lower)) {
      penalty += 50;
      reasons.push("outro");
      break;
    }
  }

  let adHits = 0;
  for (const pat of AD_PROMO_PATTERNS) {
    if (pat.test(lower)) adHits++;
  }
  if (adHits > 0) {
    penalty += 30 + adHits * 15;
    reasons.push("ad/promo");
  }

  const introZone = Math.min(duration * 0.1, 90);
  const outroZone = Math.min(duration * 0.1, 90);
  const viralMultiplier = isViral ? 1.5 : 1;

  if (startSec < introZone) {
    const proximity = 1 - startSec / introZone;
    const posPenalty = proximity * 20 * viralMultiplier;
    penalty += posPenalty;
    if (posPenalty > 5) reasons.push("near-start");
  }

  if (endSec > duration - outroZone) {
    const proximity = 1 - (duration - endSec) / outroZone;
    const posPenalty = proximity * 20 * viralMultiplier;
    penalty += posPenalty;
    if (posPenalty > 5) reasons.push("near-end");
  }

  return { penalty, reasons };
}

export function scoreText(text: string): number {
  let score = 0;
  for (const { pattern, weight } of STRONG_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) score += matches.length * weight;
  }
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
  _platform: string,
  goal: string
): Preset {
  if (goal === "viral") {
    return {
      minLen: 20,
      maxLen: 30,
      count: 5,
    };
  }
  // monetize (or default/unknown)
  return {
    minLen: 60,
    maxLen: 90,
    count: 3,
  };
}

export function findBestMoments(
  transcript: Transcript,
  preset: Preset
): ClipCandidate[] {
  const { duration, segments } = transcript;
  if (segments.length === 0) return [];

  const isViral = preset.maxLen <= 30;

  const hardSkipStart = 15;
  const hardSkipEnd = Math.max(0, duration - 15);

  const valid = segments.filter(
    (s) => s.start >= hardSkipStart && s.end <= hardSkipEnd
  );
  if (valid.length === 0) return [];

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

    const idealLen = (preset.minLen + preset.maxLen) / 2;
    const lenPenalty = Math.abs(windowLen - idealLen) * 0.1;

    const { penalty: contentPenalty, reasons } = classifyContent(
      fullText,
      valid[i].start,
      windowEnd,
      duration,
      isViral
    );

    if (reasons.length > 0) {
      console.log(
        `[Clip Filter] Penalized candidate ${valid[i].start.toFixed(1)}s-${windowEnd.toFixed(1)}s: ${reasons.join(", ")} (penalty=${contentPenalty.toFixed(1)}, rawScore=${rawScore})`
      );
    }

    const finalScore = Math.max(0, rawScore - lenPenalty - contentPenalty);

    candidates.push({
      startSec: valid[i].start,
      endSec: windowEnd,
      hook: pickHook(windowSegs),
      confidence: finalScore,
      segments: [...windowSegs],
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  const selected: ClipCandidate[] = [];
  for (const c of candidates) {
    if (selected.length >= preset.count) break;
    if (selected.some((s) => overlaps(s, c))) continue;
    selected.push(c);
  }

  const maxConf = Math.max(...selected.map((c) => c.confidence), 1);
  for (const c of selected) {
    c.confidence = Math.round((c.confidence / maxConf) * 100);
  }

  selected.sort((a, b) => a.startSec - b.startSec);

  return selected;
}
