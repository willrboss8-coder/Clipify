/** Shared error normalization for the clip processing pipeline. */

export function normalizeProcessError(err: unknown): string {
  if (!(err instanceof Error)) {
    return typeof err === "string" ? err : "Unknown error during processing";
  }
  const e = err as NodeJS.ErrnoException;
  const msg = err.message || "";

  if (e.code === "ENOENT") {
    if (/ffmpeg|ffprobe/i.test(msg)) {
      return "ffmpeg or ffprobe is not installed or not on PATH (required on the server).";
    }
    if (/python|python3/i.test(msg)) {
      return "Python was not found. Install python3 or set PYTHON_PATH to the Python that has faster-whisper.";
    }
    return `Missing file or path: ${msg}`;
  }
  if (e.code === "EACCES" || e.code === "EPERM") {
    return "Permission denied writing storage. Check STORAGE_ROOT and filesystem permissions.";
  }
  if (msg.includes("python3 exited") || msg.includes("faster-whisper")) {
    return `Transcription failed: ${msg}`;
  }
  return msg;
}
