import type { TranscriptSegment } from "./segmenter";

/** Escape plain text for ASS Dialogue lines (avoid accidental override tags) */
function escapeAssText(text: string): string {
  return text
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, " ")
    .replace(/\{/g, "（")
    .replace(/\}/g, "）");
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
 * Single viral style: small one-line captions, strong outline/shadow, bottom third.
 * {\q2} = no wrapping (no multi-line stacking from one event); Alignment 2 = bottom center.
 */
export function buildViralAss(segments: TranscriptSegment[]): string {
  const header = `[Script Info]
Title: Clipify Viral
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Viral,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,90,90,0,0,1,3,2,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines: string[] = [];
  segments.forEach((seg) => {
    const relStart = Math.max(0, seg.start);
    const relEnd = Math.max(relStart + 0.04, seg.end);
    const t0 = secondsToAssTime(relStart);
    const t1 = secondsToAssTime(relEnd);
    const plain = escapeAssText(seg.text);
    if (!plain) return;
    const body = `{\\q2\\an2}${plain}`;
    lines.push(`Dialogue: 0,${t0},${t1},Viral,,0,0,0,,${body}`);
  });

  return header + lines.join("\n") + "\n";
}
