import { copyFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import {
  isYoutubeDlpAuthLikeFailure,
  YoutubeDlpUserError,
  YOUTUBE_AUTH_FRIENDLY_MESSAGE,
} from "@/lib/youtube-dlp-errors";

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

function looksLikeCookiesPastedAsPath(p: string): boolean {
  if (p.includes("\n")) return true;
  const head = p.slice(0, 80).toLowerCase();
  if (head.includes("# netscape http cookie file")) return true;
  if (head.includes("# http cookie file")) return true;
  return false;
}

/**
 * Render (and similar) mount secret files under /etc/secrets/ read-only. yt-dlp updates
 * the cookie jar on exit, which throws OSError 30 if --cookies points at that path.
 * Copy to a writable temp file when needed.
 */
function resolveYtDlpCookiesPath(source: string): string {
  if (source.startsWith("/etc/secrets/")) {
    const dest = join(tmpdir(), `yt-dlp-cookies-${randomUUID()}.txt`);
    copyFileSync(source, dest);
    return dest;
  }
  return source;
}

/**
 * Optional Netscape cookies file for yt-dlp (`YT_DLP_COOKIES_FILE`).
 * Value must be a **filesystem path** to a cookies file (e.g. `/etc/secrets/youtube-cookies.txt` on Render),
 * not the file contents. If the path is set but missing, logs a warning and omits cookies (same as unset).
 */
export function ytDlpCookieArgs(): string[] {
  const p = process.env.YT_DLP_COOKIES_FILE?.trim();
  if (!p) return [];
  if (looksLikeCookiesPastedAsPath(p)) {
    console.warn(
      "[yt-dlp] YT_DLP_COOKIES_FILE must be a path to a cookies file (e.g. /etc/secrets/youtube-cookies.txt), not the cookie text. On Render: put contents under Secret Files; set this env var to /etc/secrets/<filename> only."
    );
    return [];
  }
  if (!existsSync(p)) {
    console.warn(
      `[yt-dlp] YT_DLP_COOKIES_FILE is set but file not found (skipping): ${p}`
    );
    return [];
  }
  const cookiesPath = resolveYtDlpCookiesPath(p);
  if (cookiesPath !== p) {
    console.log("[yt-dlp] using writable copy of cookies for yt-dlp (secret mount is read-only)");
  }
  return ["--cookies", cookiesPath];
}

/** True when a readable cookies file is configured (yt-dlp uses different client presets with cookies). */
export function hasYtDlpCookiesFile(): boolean {
  const p = process.env.YT_DLP_COOKIES_FILE?.trim();
  return Boolean(p && existsSync(p));
}

/**
 * YouTube often blocks the default web client on datacenter IPs. Retry with alternate
 * `player_client` chains (see yt-dlp YouTube extractor docs). Override entirely with
 * `YT_DLP_YOUTUBE_EXTRACTOR_ARGS` (single string, e.g. `youtube:player_client=tv_downgraded,web_safari`).
 */
export function youtubeExtractorStrategies(): string[] {
  const override = process.env.YT_DLP_YOUTUBE_EXTRACTOR_ARGS?.trim();
  if (override) {
    return [override.startsWith("youtube:") ? override : `youtube:${override}`];
  }
  const withCookies = hasYtDlpCookiesFile();
  // Order: match yt-dlp’s logged-in presets where possible, then common server-friendly clients.
  const strategies = withCookies
    ? [
        "youtube:player_client=tv_downgraded,web_safari",
        "youtube:player_client=android_vr,web_safari",
        "youtube:player_client=ios,web",
        "youtube:player_client=mweb,web",
      ]
    : [
        "youtube:player_client=android_vr,web_safari",
        "youtube:player_client=tv_downgraded,web_safari",
        "youtube:player_client=ios,web",
        "youtube:player_client=mweb,web",
      ];
  return strategies;
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
  const strategies = youtubeExtractorStrategies();
  const cookieArgs = ytDlpCookieArgs();
  let lastStderr = "";
  let lastStdout = "";
  for (const strategy of strategies) {
    const args = [
      ...cookieArgs,
      "--extractor-args",
      strategy,
      "--no-playlist",
      "--skip-download",
      "--dump-json",
      "--no-warnings",
      url,
    ];
    const { code, stdout, stderr } = await runYtDlp(args);
    lastStderr = stderr;
    lastStdout = stdout;
    if (code === 0 && stdout.trim()) {
      console.log(`[yt-dlp] metadata ok (${strategy})`);
      let parsed: { duration?: number; title?: string };
      try {
        parsed = JSON.parse(stdout) as { duration?: number; title?: string };
      } catch {
        throw new Error("Could not parse video metadata.");
      }
      const duration = parsed.duration;
      if (
        typeof duration !== "number" ||
        !Number.isFinite(duration) ||
        duration <= 0
      ) {
        throw new Error(
          "Video duration unavailable (live streams may not be supported)."
        );
      }
      return {
        durationSec: duration,
        title: typeof parsed.title === "string" ? parsed.title : undefined,
      };
    }
    console.warn(`[yt-dlp] metadata attempt failed (${strategy}):`, stderr.slice(-500));
  }
  const combined = `${lastStderr}\n${lastStdout}`;
  console.error(
    "[yt-dlp] metadata failed after all strategies (raw stderr tail):\n",
    lastStderr.slice(-8000)
  );
  if (isYoutubeDlpAuthLikeFailure(combined)) {
    throw new YoutubeDlpUserError(YOUTUBE_AUTH_FRIENDLY_MESSAGE);
  }
  throw new Error(
    "Could not read video metadata. The link may be unavailable or unsupported."
  );
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
  const strategies = youtubeExtractorStrategies();
  const cookieArgs = ytDlpCookieArgs();
  let lastStderr = "";
  let lastStdout = "";
  for (const strategy of strategies) {
    const args = [
      ...cookieArgs,
      "--extractor-args",
      strategy,
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
    const { code, stdout, stderr } = await runYtDlp(args);
    lastStderr = stderr;
    lastStdout = stdout;
    if (code === 0) {
      console.log(`[yt-dlp] download ok (${strategy})`);
      return;
    }
    console.warn(`[yt-dlp] download attempt failed (${strategy}):`, stderr.slice(-500));
  }
  const combined = `${lastStderr}\n${lastStdout}`;
  console.error(
    "[yt-dlp] download failed after all strategies (raw stderr tail):\n",
    lastStderr.slice(-8000)
  );
  if (isYoutubeDlpAuthLikeFailure(combined)) {
    throw new YoutubeDlpUserError(YOUTUBE_AUTH_FRIENDLY_MESSAGE);
  }
  throw new Error(
    "Could not download this video. It may be private, region-blocked, or temporarily unavailable."
  );
}
