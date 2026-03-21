import { auth } from "@clerk/nextjs/server";
import { clerkClient } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { readFile, writeFile, stat } from "fs/promises";
import { burnViralCaptions } from "@/lib/ffmpeg";
import { parseSrt } from "@/lib/srt";
import { expandSegmentsForViralCaptions } from "@/lib/viral-chunk";
import { buildViralAss } from "@/lib/viral-ass";
import { normalizePlan } from "@/lib/plans";
import {
  getViralCaptionAccess,
  proTrialUsedFromPrivateMetadata,
  VIRAL_TRIAL_FLAG_KEY,
} from "@/lib/viral-captions";

export const runtime = "nodejs";

const ROOT = path.resolve(process.cwd(), "storage");

function parseOutputClipFile(
  clipUrl: string
): { jobId: string; fileName: string } | null {
  const m = clipUrl.match(/\/outputs\/([^/]+)\/([^?]+)/);
  if (!m) return null;
  return { jobId: m[1], fileName: m[2] };
}

/** Current clip may be *_viral.mp4; burn always uses the non-viral base file */
function sourceFileNameForViral(fileName: string): string {
  if (!/\.mp4$/i.test(fileName)) return fileName;
  const base = fileName.replace(/\.mp4$/i, "");
  if (base.endsWith("_viral")) {
    return `${base.replace(/_viral$/, "")}.mp4`;
  }
  return fileName;
}

function viralOutputFileName(sourceFileName: string): string {
  const base = sourceFileName.replace(/\.mp4$/i, "");
  return `${base}_viral.mp4`;
}

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const plan = normalizePlan(user.publicMetadata?.plan);
    const trialUsed = proTrialUsedFromPrivateMetadata(
      user.privateMetadata as Record<string, unknown> | undefined
    );
    const access = getViralCaptionAccess(plan, trialUsed);

    return NextResponse.json({ access, plan, trialUsed });
  } catch (err) {
    console.error("[viral-captions GET]", err);
    return NextResponse.json(
      { error: "Failed to load viral caption access" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const plan = normalizePlan(user.publicMetadata?.plan);
    const trialUsed = proTrialUsedFromPrivateMetadata(
      user.privateMetadata as Record<string, unknown> | undefined
    );
    const access = getViralCaptionAccess(plan, trialUsed);

    if (access === "none") {
      return NextResponse.json(
        {
          error:
            "Premium viral captions are available on Pro (1 trial) and Power (full access).",
          code: "UPGRADE_REQUIRED",
        },
        { status: 403 }
      );
    }
    if (access === "exhausted") {
      return NextResponse.json(
        {
          error:
            "You've used your Pro trial of viral captions. Upgrade to Power for unlimited burns.",
          code: "TRIAL_USED",
        },
        { status: 403 }
      );
    }

    const body = (await req.json()) as { clipUrl?: string };
    const clipUrl = body.clipUrl as string;
    if (!clipUrl || typeof clipUrl !== "string") {
      return NextResponse.json({ error: "Missing clipUrl" }, { status: 400 });
    }

    const parsed = parseOutputClipFile(clipUrl);
    if (!parsed) {
      return NextResponse.json(
        { error: "Invalid clip URL (expected /outputs/...)" },
        { status: 400 }
      );
    }

    const { jobId, fileName } = parsed;
    if (!/^[\w-]+$/.test(jobId)) {
      return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
    }
    if (!/^clip_\d+(?:_alt)?(?:_viral)?\.mp4$/i.test(fileName)) {
      return NextResponse.json({ error: "Invalid clip file" }, { status: 400 });
    }

    const sourceName = sourceFileNameForViral(fileName);
    const outputName = viralOutputFileName(sourceName);
    const outputDir = path.join(ROOT, "outputs", jobId);
    const videoPath = path.join(outputDir, sourceName);
    const srtPath = path.join(
      outputDir,
      sourceName.replace(/\.mp4$/i, ".srt")
    );
    const assPath = path.join(
      outputDir,
      `viral_${sourceName.replace(/\.mp4$/i, "")}.ass`
    );
    const outPath = path.join(outputDir, outputName);

    try {
      await stat(videoPath);
    } catch {
      return NextResponse.json(
        { error: "Clip file not found on server" },
        { status: 404 }
      );
    }

    const srtContent = await readFile(srtPath, "utf-8");
    const segments = parseSrt(srtContent);
    if (segments.length === 0) {
      return NextResponse.json(
        { error: "No caption lines found for this clip (missing .srt?)" },
        { status: 400 }
      );
    }

    const viralSegments = expandSegmentsForViralCaptions(segments);
    const assContent = buildViralAss(viralSegments);
    await writeFile(assPath, assContent, "utf-8");

    try {
      await burnViralCaptions(videoPath, assPath, outPath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[viral-captions] ffmpeg burn failed:", msg);
      return NextResponse.json(
        {
          error:
            "Could not burn captions with ffmpeg. This server needs ffmpeg built with libass (subtitles). Plain .srt download still works.",
          code: "FFMPEG_BURN_FAILED",
          detail: msg,
        },
        { status: 503 }
      );
    }

    if (access === "trial") {
      await client.users.updateUserMetadata(userId, {
        privateMetadata: { [VIRAL_TRIAL_FLAG_KEY]: true },
      });
    }

    const version = Date.now().toString();
    const nextAccess =
      access === "trial" ? "exhausted" : "full";

    return NextResponse.json({
      clipUrl: `/api/files/outputs/${jobId}/${outputName}?v=${version}`,
      viralApplied: true,
      accessAfter: nextAccess,
    });
  } catch (err) {
    console.error("[viral-captions POST]", err);
    return NextResponse.json(
      { error: "Viral captions failed" },
      { status: 500 }
    );
  }
}
