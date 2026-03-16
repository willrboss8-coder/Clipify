import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { readFile, copyFile, mkdir } from "fs/promises";
import { cutClip } from "@/lib/ffmpeg";
import { writeSrt } from "@/lib/srt";
import {
  getPreset,
  findBestMoments,
  type Transcript,
  type ClipCandidate,
} from "@/lib/segmenter";

export const runtime = "nodejs";

const ROOT = path.resolve(process.cwd(), "storage");

interface ClipRange {
  startSec: number;
  endSec: number;
}

interface AlternativeRequestBody {
  jobId: string;
  clipIndex: number;
  platform: string;
  goal: string;
  currentStartSec?: number;
  currentEndSec?: number;
  allClipRanges?: ClipRange[];
  seenRanges?: ClipRange[];
}

function overlapsRange(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<AlternativeRequestBody>;
    const jobId = body.jobId;
    const clipIndex = body.clipIndex;
    const platform = body.platform || "tiktok";
    const goal = body.goal || "viral";
    const currentStartSec = body.currentStartSec ?? 0;
    const currentEndSec = body.currentEndSec ?? 0;
    const allClipRanges: ClipRange[] = Array.isArray(body.allClipRanges) ? body.allClipRanges : [];
    const seenRanges: ClipRange[] = Array.isArray(body.seenRanges) ? body.seenRanges : [];

    if (!jobId || typeof clipIndex !== "number") {
      return NextResponse.json(
        { error: "Missing jobId or clipIndex" },
        { status: 400 }
      );
    }

    console.log(`[Clip Debug] Alternative request for clipIndex=${clipIndex}, jobId=${jobId}`);
    console.log(`[Clip Debug] Alternative exclusion ranges received for clipIndex=${clipIndex}: ${allClipRanges.length} active, ${seenRanges.length} seen`);

    const jobDir = path.join(ROOT, "jobs", jobId);
    const outputDir = path.join(ROOT, "outputs", jobId);
    const uploadsDir = path.join(ROOT, "uploads");
    const videoPath = path.join(uploadsDir, `${jobId}.mp4`);
    const transcriptPath = path.join(jobDir, "transcript.json");

    const transcriptRaw = await readFile(transcriptPath, "utf-8");
    const transcript: Transcript = JSON.parse(transcriptRaw);

    const preset = getPreset(platform, goal);
    const candidates = findBestMoments(transcript, preset);
    if (!candidates.length) {
      return NextResponse.json(
        { error: "No alternative clips available" },
        { status: 404 }
      );
    }

    const activeExclusions: ClipRange[] = allClipRanges.length > 0
      ? allClipRanges
      : [{ startSec: currentStartSec, endSec: currentEndSec }];

    const allExclusions: ClipRange[] = [...activeExclusions, ...seenRanges];

    const nonOverlapping = candidates.filter((c: ClipCandidate) => {
      for (const r of allExclusions) {
        if (overlapsRange(c.startSec, c.endSec, r.startSec, r.endSec)) {
          const isSeen = seenRanges.some(
            (sr) => overlapsRange(c.startSec, c.endSec, sr.startSec, sr.endSec)
          );
          if (isSeen) {
            console.log(
              `[Clip Debug] Candidate rejected because it was already seen for this slot: ${c.startSec.toFixed(1)}s-${c.endSec.toFixed(1)}s`
            );
          }
          return false;
        }
      }
      return true;
    });

    if (nonOverlapping.length === 0) {
      console.log(`[Clip Debug] No unseen alternatives remain for clipIndex=${clipIndex} (${candidates.length} candidates, all excluded)`);
      return NextResponse.json(
        { error: "No new clip options left for this section." },
        { status: 404 }
      );
    }

    const chosen = nonOverlapping[0];
    console.log(`[Clip Debug] Returning unseen alternative for clipIndex=${clipIndex}: ${chosen.startSec.toFixed(1)}s-${chosen.endSec.toFixed(1)}s`);

    const clipNum = clipIndex + 1;
    const srtPath = path.join(jobDir, `clip_${clipNum}_alt.srt`);
    const outputSrt = path.join(outputDir, `clip_${clipNum}_alt.srt`);
    const clipPath = path.join(outputDir, `clip_${clipNum}_alt.mp4`);

    await mkdir(outputDir, { recursive: true });

    console.log(`[Clip Debug] Writing alternative clip to ${clipPath}`);

    await writeSrt(chosen.segments, chosen.startSec, srtPath);
    await copyFile(srtPath, outputSrt);
    await cutClip(videoPath, chosen.startSec, chosen.endSec, clipPath);

    const version = Date.now().toString();
    const clipUrl = `/api/files/outputs/${jobId}/clip_${clipNum}_alt.mp4?v=${version}`;
    const srtUrl = `/api/files/outputs/${jobId}/clip_${clipNum}_alt.srt?v=${version}`;

    console.log(`[Clip Debug] Returning clipIndex=${clipIndex}, clipUrl=${clipUrl}`);

    return NextResponse.json({
      clipIndex,
      clipUrl,
      srtUrl,
      startSec: chosen.startSec,
      endSec: chosen.endSec,
      hook: chosen.hook,
      confidence: chosen.confidence,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Alternative clip error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

