import { unlink, writeFile } from "fs/promises";
import path from "path";
import { getJobDir } from "@/lib/jobStore";
import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";

const CLAIM_FILE = "claim.lock";

export function getClaimLockPath(jobId: string): string {
  return path.join(getJobDir(jobId), CLAIM_FILE);
}

/**
 * Atomically claim a queued job using exclusive file creation (O_EXCL / flag wx).
 * Only one process can create claim.lock; then we re-read state and move queued → processing.
 */
export async function tryClaimJob(jobId: string): Promise<boolean> {
  const lockPath = getClaimLockPath(jobId);
  try {
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        at: new Date().toISOString(),
      }),
      { flag: "wx" }
    );
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") return false;
    throw e;
  }

  const rec = await readJobRecord(jobId);
  if (!rec || rec.status !== "queued") {
    await unlink(lockPath).catch(() => {});
    return false;
  }

  await writeJobRecord(patchJobRecord(rec, { status: "processing" }));
  return true;
}

/** Remove claim.lock after job reaches a terminal state (completed / failed). */
export async function releaseClaim(jobId: string): Promise<void> {
  await unlink(getClaimLockPath(jobId)).catch(() => {});
}
