import { spawn } from "child_process";

function ytDlpExecutable(): string {
  const fromEnv = process.env.YT_DLP_PATH?.trim();
  if (fromEnv) return fromEnv;
  return "yt-dlp";
}

export interface YtDlpResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run yt-dlp with args. Requires `yt-dlp` on PATH (e.g. pip install in venv) or `YT_DLP_PATH`.
 */
export function runYtDlp(args: string[]): Promise<YtDlpResult> {
  return new Promise((resolve, reject) => {
    const exe = ytDlpExecutable();
    const child = spawn(exe, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export interface YoutubeMetadataResult {
  durationSec: number;
  title?: string;
}

/**
 * Fetch duration (and title) without downloading the video.
 */
export async function fetchYoutubeMetadata(
  url: string
): Promise<YoutubeMetadataResult> {
  const args = [
    "--no-playlist",
    "--skip-download",
    "--dump-json",
    "--no-warnings",
    url,
  ];
  const { code, stdout, stderr } = await runYtDlp(args);
  if (code !== 0) {
    const msg = stderr.trim() || stdout.trim() || "yt-dlp metadata failed";
    throw new Error(msg.slice(-2000));
  }
  let parsed: { duration?: number; title?: string };
  try {
    parsed = JSON.parse(stdout) as { duration?: number; title?: string };
  } catch {
    throw new Error("Could not parse video metadata.");
  }
  const duration = parsed.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration unavailable (live streams may not be supported).");
  }
  return {
    durationSec: duration,
    title: typeof parsed.title === "string" ? parsed.title : undefined,
  };
}

/**
 * Download best-effort MP4 to an exact path (overwrites).
 */
export async function assertYtDlpAvailable(): Promise<void> {
  try {
    const r = await runYtDlp(["--version"]);
    if (r.code !== 0) {
      throw new Error(
        "yt-dlp is not working. Install the `yt-dlp` package (e.g. pip install yt-dlp) or set YT_DLP_PATH."
      );
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      throw new Error(
        "yt-dlp is not installed. Add `yt-dlp` to your Python environment (see requirements.txt) or set YT_DLP_PATH."
      );
    }
    throw e;
  }
}

export async function downloadYoutubeToFile(
  url: string,
  destPath: string
): Promise<void> {
  const args = [
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "--merge-output-format",
    "mp4",
    "-f",
    "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best",
    "-o",
    destPath,
    url,
  ];
  const { code, stderr } = await runYtDlp(args);
  if (code !== 0) {
    const msg = stderr.trim() || "yt-dlp download failed";
    throw new Error(msg.slice(-2000));
  }
}
