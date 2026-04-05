import path from "path";

/**
 * Naming layout for job source video on disk and in object storage.
 *
 * **Current behavior (production):** a single full-quality file drives upload, transcription,
 * moment selection, clip rendering, and regenerate/alternative flows:
 * - Local: `{STORAGE_ROOT}/uploads/<jobId>.mp4`
 * - R2 (direct upload): `jobs/<jobId>/source.mp4` — see `r2SourceObjectKey` in `lib/r2.ts`
 *
 * **Planned proxy workflow (not implemented yet):** optionally add a second file for faster
 * upload + analysis while keeping the master for final export:
 * - Proxy (analysis / preview): `uploads/<jobId>.proxy.mp4` and optionally `jobs/<jobId>/proxy.mp4` in R2
 * - Full (export / high-quality cuts): `uploads/<jobId>.mp4` (unchanged)
 *
 * Transcription and clip detection would read timestamps in **proxy timeline space**; ffmpeg cuts
 * for delivery must use **full** source with the same second indices only if proxy is a
 * time-preserving transcode (same duration, no frame drift). Validate with ffprobe in any future implementation.
 *
 * Until dual-source is implemented, all callers should use {@link jobFullVideoBasename} only.
 */

/** High-quality master filename under `uploads/`. */
export function jobFullVideoBasename(jobId: string): string {
  return `${jobId}.mp4`;
}

/** Planned low-bitrate proxy filename under `uploads/` (not written by current pipeline). */
export function jobProxyVideoBasename(jobId: string): string {
  return `${jobId}.proxy.mp4`;
}

/** Absolute path to the canonical full source file (current pipeline default). */
export function localFullSourcePath(uploadsDir: string, jobId: string): string {
  return path.join(uploadsDir, jobFullVideoBasename(jobId));
}

/** Planned absolute path to proxy file (not used until dual-source workflow exists). */
export function localProxySourcePath(uploadsDir: string, jobId: string): string {
  return path.join(uploadsDir, jobProxyVideoBasename(jobId));
}
