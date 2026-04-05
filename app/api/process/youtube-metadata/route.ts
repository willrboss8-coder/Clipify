import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { hasTranscriptionScript } from "@/lib/persistent-transcribe";
import {
  fetchYoutubeMetadata,
  assertYtDlpAvailable,
} from "@/lib/youtube-download";
import { YoutubeDlpUserError } from "@/lib/youtube-dlp-errors";
import { isAllowedYoutubeUrl, normalizeYoutubeUrl } from "@/lib/youtube-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  const safe = message.slice(0, 2000);
  return NextResponse.json(
    { error: safe },
    {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }
  );
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    logClerkAuthDebug("api/process/youtube-metadata:POST", req, { userId });
    if (!userId) {
      return jsonError("Unauthorized", 401);
    }

    if (!hasTranscriptionScript()) {
      return jsonError(
        "Transcription scripts missing (expected scripts/transcribe_daemon.py or scripts/transcribe.py).",
        500
      );
    }

    let body: { youtubeUrl?: string };
    try {
      body = (await req.json()) as { youtubeUrl?: string };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const raw = typeof body.youtubeUrl === "string" ? body.youtubeUrl : "";
    const youtubeUrl = normalizeYoutubeUrl(raw);
    if (!youtubeUrl || !isAllowedYoutubeUrl(youtubeUrl)) {
      return jsonError(
        "Enter a valid YouTube link (youtube.com or youtu.be).",
        400
      );
    }

    try {
      await assertYtDlpAvailable();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "yt-dlp is not available";
      return jsonError(msg, 503);
    }

    try {
      const meta = await fetchYoutubeMetadata(youtubeUrl);
      return NextResponse.json(
        {
          durationSec: meta.durationSec,
          title: meta.title ?? null,
        },
        {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    } catch (e: unknown) {
      if (e instanceof YoutubeDlpUserError) {
        console.error("[youtube-metadata] auth/bot wall (details in yt-dlp logs above)");
        return NextResponse.json(
          { error: e.message, code: e.code },
          {
            status: 403,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          }
        );
      }
      const msg =
        e instanceof Error ? e.message : "Could not read video metadata.";
      return jsonError(msg.slice(0, 2000), 400);
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to read YouTube metadata";
    console.error("youtube-metadata error:", err);
    return jsonError(message, 500);
  }
}
