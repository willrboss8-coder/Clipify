import { unlink, writeFile } from "fs/promises";
import path from "path";
import { getJobDir } from "@/lib/jobStore";
import type { StageWorkerKind } from "@/lib/pipeline/queue-model";

/**
 * Exclusive lease for one stage of one job. Release when work finishes or aborts.
 * Future multi-worker: only one process should hold a lease for (jobId, kind) at a time.
 */
export interface StageLease {
  readonly jobId: string;
  readonly kind: StageWorkerKind;
  release(): Promise<void>;
}

/**
 * Acquire an exclusive lease before running stage work, or return null if busy.
 */
export interface StageLeaseBackend {
  tryAcquire(jobId: string, kind: StageWorkerKind): Promise<StageLease | null>;
}

/** Single in-process runner: no contention; always acquires (no-op release). */
export function createNoopLeaseBackend(): StageLeaseBackend {
  return {
    async tryAcquire(jobId: string, kind: StageWorkerKind): Promise<StageLease | null> {
      return {
        jobId,
        kind,
        async release() {
          /* no-op */
        },
      };
    },
  };
}

/**
 * One-box multi-process: O_EXCL lock file per (job, stage worker kind).
 * Compatible with shared STORAGE_ROOT; no Redis required.
 */
export function createFilesystemStageLeaseBackend(): StageLeaseBackend {
  return {
    async tryAcquire(jobId: string, kind: StageWorkerKind): Promise<StageLease | null> {
      const lockPath = path.join(getJobDir(jobId), `lease-${kind}.lock`);
      try {
        await writeFile(
          lockPath,
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
          { flag: "wx" }
        );
        return {
          jobId,
          kind,
          async release() {
            await unlink(lockPath).catch(() => {});
          },
        };
      } catch {
        return null;
      }
    },
  };
}
