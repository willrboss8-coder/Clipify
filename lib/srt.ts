import { writeFile } from "fs/promises";
import type { TranscriptSegment } from "./segmenter";

function parseSrtTime(line: string): number {
  const normalized = line.trim().replace(",", ".");
  const m = normalized.match(
    /^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/
  );
  if (!m) return 0;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const frac = m[4].padEnd(3, "0").slice(0, 3);
  const ms = parseInt(frac, 10);
  return h * 3600 + min * 60 + s + ms / 1000;
}

/** Parse SRT content into segments with times in seconds (same timeline as file) */
export function parseSrt(content: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const blocks = content.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    const timeLine = lines[idx];
    if (!timeLine) continue;
    const m = timeLine.match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/
    );
    if (!m) continue;
    const start = parseSrtTime(m[1]);
    const end = parseSrtTime(m[2]);
    const text = lines
      .slice(idx + 1)
      .join("\n")
      .trim();
    if (text) out.push({ start, end, text });
  }
  return out;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function buildSrt(
  segments: TranscriptSegment[],
  clipStart: number
): string {
  const lines: string[] = [];
  segments.forEach((seg, i) => {
    const relStart = Math.max(0, seg.start - clipStart);
    const relEnd = seg.end - clipStart;
    lines.push(String(i + 1));
    lines.push(`${formatTime(relStart)} --> ${formatTime(relEnd)}`);
    lines.push(seg.text.trim());
    lines.push("");
  });
  return lines.join("\n");
}

export async function writeSrt(
  segments: TranscriptSegment[],
  clipStart: number,
  outputPath: string
): Promise<void> {
  const content = buildSrt(segments, clipStart);
  await writeFile(outputPath, content, "utf-8");
}
