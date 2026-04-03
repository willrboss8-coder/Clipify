import type { JobRecord } from "@/lib/types/clip-job";

/** Recommended max processing window (seconds). */
export const MAX_PROCESSING_WINDOW_SEC = 3600;

export type LongVideoSegment = "beginning" | "middle" | "end";

/**
 * Compute [start, end) scan window in seconds on the source file.
 * For totalSec <= MAX, returns full [0, totalSec].
 */
export function computeScanWindowSec(
  totalSec: number,
  segment: LongVideoSegment | undefined
): { startSec: number; endSec: number } | null {
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    return { startSec: 0, endSec: 0 };
  }
  if (totalSec <= MAX_PROCESSING_WINDOW_SEC) {
    return { startSec: 0, endSec: totalSec };
  }
  if (!segment) {
    return null;
  }
  if (segment === "beginning") {
    return { startSec: 0, endSec: MAX_PROCESSING_WINDOW_SEC };
  }
  if (segment === "end") {
    const startSec = Math.max(0, totalSec - MAX_PROCESSING_WINDOW_SEC);
    return { startSec, endSec: totalSec };
  }
  // middle: center a 60-minute window
  const startSec = Math.max(0, (totalSec - MAX_PROCESSING_WINDOW_SEC) / 2);
  return {
    startSec,
    endSec: Math.min(totalSec, startSec + MAX_PROCESSING_WINDOW_SEC),
  };
}

/** Resolve persisted scan bounds vs full file duration (legacy jobs = full file). */
export function getJobScanBounds(
  rec: Pick<JobRecord, "scanStartSec" | "scanEndSec"> | null,
  fullDurationSec: number
): { startSec: number; endSec: number } {
  if (
    rec?.scanStartSec == null ||
    rec?.scanEndSec == null ||
    !Number.isFinite(fullDurationSec) ||
    fullDurationSec <= 0
  ) {
    return { startSec: 0, endSec: fullDurationSec };
  }
  const startSec = Math.max(0, Math.min(rec.scanStartSec, fullDurationSec));
  const endSec = Math.max(startSec, Math.min(rec.scanEndSec, fullDurationSec));
  return { startSec, endSec };
}
