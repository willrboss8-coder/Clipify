import type { TranscriptSegment } from "./segmenter";
import { viralAssMarginLRPx } from "./viral-width";

/** Soft warm accent (BGR) — premium, single highlight color */
const VIRAL_ACCENT_PRIMARY = "&H00A8D8FF";
const VIRAL_TEXT_WHITE = "&HFFFFFF";

/** Escape a single word for ASS (inline tags use real braces). */
function escapeAssWord(word: string): string {
  return word
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, " ")
    .replace(/\{/g, "（")
    .replace(/\}/g, "）");
}

/**
 * Build dialogue body: \\q2 \\an2 + optional one-word \\c accent.
 */
function buildViralCaptionDialogueText(seg: TranscriptSegment): string {
  const raw = seg.text.trim();
  if (!raw) return "";

  const words = raw.split(/\s+/).filter(Boolean);
  const hi = seg.highlightWordIndex;

  if (
    hi == null ||
    hi < 0 ||
    hi >= words.length ||
    words.length === 0
  ) {
    return `{\\q2\\an2}${words.map(escapeAssWord).join(" ")}`;
  }

  const parts: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const ew = escapeAssWord(words[i]!);
    if (i === hi) {
      parts.push(
        `{\\c${VIRAL_ACCENT_PRIMARY}}${ew}{\\c${VIRAL_TEXT_WHITE}}`
      );
    } else {
      parts.push(ew);
    }
  }
  return `{\\q2\\an2}${parts.join(" ")}`;
}

/** Convert seconds to ASS timestamp (H:MM:SS.cc) */
function secondsToAssTime(seconds: number): string {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t % 1) * 100) % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Single viral style: max one row per event (\\q2), bottom-centered (\\an2), Arial 18, outline/shadow.
 * Line length is enforced in `lib/viral-chunk.ts` (max 18 chars). MarginL/R match visible content column.
 */
export function buildViralAss(segments: TranscriptSegment[]): string {
  const m = viralAssMarginLRPx();
  const header = `[Script Info]
Title: Clipify Viral
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Viral,Arial,18,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,${m},${m},58,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines: string[] = [];
  segments.forEach((seg) => {
    const relStart = Math.max(0, seg.start);
    const relEnd = Math.max(relStart + 0.04, seg.end);
    const t0 = secondsToAssTime(relStart);
    const t1 = secondsToAssTime(relEnd);
    const body = buildViralCaptionDialogueText(seg);
    if (!body) return;
    lines.push(`Dialogue: 0,${t0},${t1},Viral,,0,0,0,,${body}`);
  });

  return header + lines.join("\n") + "\n";
}
