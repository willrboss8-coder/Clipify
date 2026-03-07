import { writeFile } from "fs/promises";
import type { TranscriptSegment } from "./segmenter";

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
