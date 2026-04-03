"use client";

import {
  computeScanWindowSec,
  type LongVideoSegment,
} from "@/lib/scan-window";

/** Skip client trim above this size to reduce OOM risk (full file is loaded in WASM memory). */
export const DEFAULT_MAX_CLIENT_TRIM_BYTES = 900 * 1024 * 1024;

export function shouldAttemptClientTrim(
  file: File,
  isLongVideo: boolean,
  maxBytes: number = DEFAULT_MAX_CLIENT_TRIM_BYTES
): boolean {
  return isLongVideo && file.size > 0 && file.size <= maxBytes;
}

let ffmpegLoadPromise: Promise<import("@ffmpeg/ffmpeg").FFmpeg> | null = null;

async function getLoadedFFmpeg(): Promise<import("@ffmpeg/ffmpeg").FFmpeg> {
  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");
      const base =
        typeof process !== "undefined" &&
        process.env.NEXT_PUBLIC_FFMPEG_CORE_BASE?.trim()
          ? process.env.NEXT_PUBLIC_FFMPEG_CORE_BASE.trim().replace(/\/$/, "")
          : "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg;
    })();
  }
  return ffmpegLoadPromise;
}

/**
 * Produces an MP4 blob containing only the selected 60-minute window (same math as the server).
 * Tries stream copy first; re-encodes if copy fails (e.g. keyframe boundaries).
 */
export async function trimLocalVideoToSegment(params: {
  file: File;
  segment: LongVideoSegment;
  originalDurationSec: number;
  onProgress?: (ratio: number) => void;
}): Promise<Blob> {
  const win = computeScanWindowSec(params.originalDurationSec, params.segment);
  if (!win) {
    throw new Error("Invalid segment for this duration");
  }
  const start = win.startSec;
  const len = win.endSec - win.startSec;

  const { fetchFile } = await import("@ffmpeg/util");
  const ffmpeg = await getLoadedFFmpeg();

  ffmpeg.on("progress", ({ progress }) => {
    params.onProgress?.(progress);
  });

  await ffmpeg.deleteFile("input.mp4").catch(() => {});
  await ffmpeg.deleteFile("out.mp4").catch(() => {});

  await ffmpeg.writeFile("input.mp4", await fetchFile(params.file));

  const tryCopy = [
    "-ss",
    String(start),
    "-i",
    "input.mp4",
    "-t",
    String(len),
    "-c",
    "copy",
    "out.mp4",
  ];
  const tryEncode = [
    "-ss",
    String(start),
    "-i",
    "input.mp4",
    "-t",
    String(len),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "out.mp4",
  ];

  let code = await ffmpeg.exec(tryCopy);
  if (code !== 0) {
    await ffmpeg.deleteFile("out.mp4").catch(() => {});
    code = await ffmpeg.exec(tryEncode);
  }
  if (code !== 0) {
    throw new Error("ffmpeg could not extract the selected segment");
  }

  const data = await ffmpeg.readFile("out.mp4");
  if (typeof data === "string") {
    throw new Error("Unexpected ffmpeg output");
  }
  return new Blob([new Uint8Array(data)], { type: "video/mp4" });
}
