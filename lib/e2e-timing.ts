/**
 * Lightweight E2E timing markers for Generate Clip → completed result.
 * Logs only; no API or persisted state changes.
 */

const completedPollLogged = new Set<string>();

export function logE2E(
  jobId: string,
  phase: string,
  meta?: Record<string, string | number | boolean>
): void {
  const ts = Date.now();
  const metaStr =
    meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[E2E] jobId=${jobId} phase=${phase} ts=${ts}${metaStr}`);
}

/** First GET /api/jobs/[jobId] that returns status=completed (once per job, in-process). */
export function logE2EApiPollCompleted(jobId: string): void {
  if (completedPollLogged.has(jobId)) return;
  completedPollLogged.add(jobId);
  if (completedPollLogged.size > 10_000) {
    completedPollLogged.clear();
  }
  logE2E(jobId, "api_poll_completed");
}
