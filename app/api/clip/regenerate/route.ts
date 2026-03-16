import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { readFile, copyFile, mkdir } from "fs/promises";
import { cutClip } from "@/lib/ffmpeg";
import { writeSrt } from "@/lib/srt";
import type { Transcript, TranscriptSegment } from "@/lib/segmenter";

export const runtime = "nodejs";

const ROOT = path.resolve(process.cwd(), "storage");

interface RegenerateRequestBody {
  jobId: string;
  clipIndex: number;
  startSec: number;
  endSec: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<RegenerateRequestBody>;
    const jobId = body.jobId;
    const clipIndex = body.clipIndex;
    const startSec = body.startSec;
    const endSec = body.endSec;

    if (!jobId || typeof clipIndex !== "number") {
      return NextResponse.json(
        { error: "Missing jobId or clipIndex" },
        { status: 400 }
      );
    }

    if (
      typeof startSec !== "number" ||
      typeof endSec !== "number" ||
      !Number.isFinite(startSec) ||
      !Number.isFinite(endSec) ||
      startSec < 0 ||
      endSec <= startSec
    ) {
      return NextResponse.json(
        { error: "Invalid startSec/endSec" },
        { status: 400 }
      );
    }

    const uploadsDir = path.join(ROOT, "uploads");
    const jobDir = path.join(ROOT, "jobs", jobId);
    const outputDir = path.join(ROOT, "outputs", jobId);
    const videoPath = path.join(uploadsDir, `${jobId}.mp4`);
    const transcriptPath = path.join(jobDir, "transcript.json");

    const transcriptRaw = await readFile(transcriptPath, "utf-8");
    const transcript: Transcript = JSON.parse(transcriptRaw);

    const windowSegments: TranscriptSegment[] = transcript.segments.filter(
      (s) => s.end > startSec && s.start < endSec
    );

    const clipNum = clipIndex + 1;
    const srtPath = path.join(jobDir, `clip_${clipNum}.srt`);
    const outputSrt = path.join(outputDir, `clip_${clipNum}.srt`);
    const clipPath = path.join(outputDir, `clip_${clipNum}.mp4`);

    await mkdir(outputDir, { recursive: true });

    console.log(`[Clip Debug] Regenerate request for clipIndex=${clipIndex}, jobId=${jobId}, start=${startSec}, end=${endSec}`);
    console.log(`[Clip Debug] Writing regenerated clip to ${clipPath}`);

    await writeSrt(windowSegments, startSec, srtPath);
    await copyFile(srtPath, outputSrt);
    await cutClip(videoPath, startSec, endSec, clipPath);

    const version = Date.now().toString();
    const clipUrl = `/api/files/outputs/${jobId}/clip_${clipNum}.mp4?v=${version}`;
    const srtUrl = `/api/files/outputs/${jobId}/clip_${clipNum}.srt?v=${version}`;

    console.log(`[Clip Debug] Returning clipIndex=${clipIndex}, clipUrl=${clipUrl}`);

    return NextResponse.json({
      clipIndex,
      clipUrl,
      srtUrl,
      startSec,
      endSec,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Regenerate clip error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

