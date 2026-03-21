import { spawn } from "child_process";
import path from "path";

function run(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, cwd ? { cwd } : undefined);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.on("error", reject);
  });
}

const ENCODE_ARGS = [
  "-c:v", "libx264", "-preset", "fast",
  "-c:a", "aac", "-b:a", "128k",
  "-movflags", "+faststart",
];

export async function extractAudio(
  videoPath: string,
  outputPath: string
): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    outputPath,
  ]);
}

export async function getVideoDuration(videoPath: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    videoPath,
  ]);
  return parseFloat(stdout.trim());
}

export async function getVideoDimensions(
  videoPath: string
): Promise<{ width: number; height: number }> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    videoPath,
  ]);
  const [w, h] = stdout.trim().split(",").map(Number);
  return { width: w, height: h };
}

// TODO: Burned-in subtitles require an ffmpeg build with libass/subtitles filter
// support (e.g. `brew install ffmpeg`). Re-enable the subtitle burn pass once
// a compatible ffmpeg is available on the build/deploy machine.
// TODO: Free-plan watermark (drawtext) requires an ffmpeg build with libfreetype/
// drawtext filter support. Re-enable the watermark pass once a compatible ffmpeg
// is available.
export async function cutClip(
  videoPath: string,
  start: number,
  end: number,
  outputPath: string
): Promise<void> {
  const duration = end - start;
  const { width, height } = await getVideoDimensions(videoPath);

  const targetW = 720;
  const targetH = 1280;
  const targetRatio = targetW / targetH;
  const srcRatio = width / height;

  let cropFilter: string;
  if (srcRatio > targetRatio) {
    const newW = Math.round(height * targetRatio);
    const x = Math.round((width - newW) / 2);
    cropFilter = `crop=${newW}:${height}:${x}:0,scale=${targetW}:${targetH}`;
  } else {
    const newH = Math.round(width / targetRatio);
    const y = Math.round((height - newH) / 2);
    cropFilter = `crop=${width}:${newH}:0:${y},scale=${targetW}:${targetH}`;
  }

  console.log("[ffmpeg] cutting clip:", start.toFixed(2), "→", end.toFixed(2));
  await run("ffmpeg", [
    "-y",
    "-ss", start.toFixed(2),
    "-i", videoPath,
    "-t", duration.toFixed(2),
    "-vf", cropFilter,
    ...ENCODE_ARGS,
    outputPath,
  ]);
}

/** Re-encode video with libass `ass` filter; requires ffmpeg built with libass */
const BURN_VIRAL_ENCODE = [
  "-c:v", "libx264",
  "-preset", "fast",
  "-c:a", "copy",
  "-movflags", "+faststart",
];

/**
 * Burn ASS subtitles onto an existing clip. Runs ffmpeg with cwd = clip directory
 * so paths stay simple for the `ass=` filter.
 */
export async function burnViralCaptions(
  clipVideoPath: string,
  assPath: string,
  outputPath: string
): Promise<void> {
  const outDir = path.dirname(clipVideoPath);
  if (path.dirname(assPath) !== outDir || path.dirname(outputPath) !== outDir) {
    throw new Error(
      "burnViralCaptions: clip, ass, and output must live in the same directory"
    );
  }
  const clipName = path.basename(clipVideoPath);
  const assName = path.basename(assPath);
  const outName = path.basename(outputPath);
  console.log("[ffmpeg] viral burn:", clipName, "+", assName, "->", outName);
  await run(
    "ffmpeg",
    ["-y", "-i", clipName, "-vf", `ass=${assName}`, ...BURN_VIRAL_ENCODE, outName],
    outDir
  );
}
