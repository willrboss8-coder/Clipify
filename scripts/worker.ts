/**
 * Background worker: polls STORAGE_ROOT/jobs for queued jobs, claims one at a time,
 * runs lib/runProcessJob.ts. Intended for Render Background Worker or local `npm run worker`.
 *
 * Requires the same STORAGE_ROOT (and ideally the same persistent disk) as the web service
 * so uploads and state.json are visible.
 */

import { readdir, stat, readFile, unlink } from "fs/promises";
import path from "path";
import { getStorageRoot } from "@/lib/storage-path";
import { readJobRecord } from "@/lib/jobStore";
import { tryClaimJob } from "@/lib/jobClaim";
import { runProcessJob } from "@/lib/runProcessJob";
import type { JobRecord } from "@/lib/types/clip-job";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const POLL_MS = 3000;
/** If claim.lock exists but state is still queued, release lock after this age (crashed worker). */
const STALE_QUEUED_LOCK_MS = 5 * 60 * 1000;

async function recoverStaleQueuedClaims(ROOT: string): Promise<void> {
  const jobsRoot = path.join(ROOT, "jobs");
  let dirs: string[];
  try {
    dirs = await readdir(jobsRoot);
  } catch {
    return;
  }

  for (const id of dirs) {
    if (!UUID_RE.test(id)) continue;
    const lockPath = path.join(jobsRoot, id, "claim.lock");
    const statePath = path.join(jobsRoot, id, "state.json");
    let st;
    try {
      st = await stat(lockPath);
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(statePath, "utf-8");
    } catch {
      continue;
    }
    let rec: JobRecord;
    try {
      rec = JSON.parse(raw) as JobRecord;
    } catch {
      continue;
    }
    if (rec.status !== "queued") continue;
    const age = Date.now() - st.mtimeMs;
    if (age > STALE_QUEUED_LOCK_MS) {
      await unlink(lockPath);
      console.log(
        `[Worker] Released stale claim.lock for ${id} (queued, lock age ${Math.round(age / 1000)}s)`
      );
    }
  }
}

async function tick(ROOT: string): Promise<void> {
  await recoverStaleQueuedClaims(ROOT);
  const jobsRoot = path.join(ROOT, "jobs");
  let dirs: string[];
  try {
    dirs = await readdir(jobsRoot);
  } catch {
    return;
  }

  for (const id of dirs) {
    if (!UUID_RE.test(id)) continue;
    const rec = await readJobRecord(id);
    if (!rec || rec.status !== "queued") continue;

    const claimed = await tryClaimJob(id);
    if (!claimed) continue;

    const claimedAtMs = Date.now();
    console.log(`[Worker] Claimed job ${id}`);
    await runProcessJob({
      jobId: id,
      userId: rec.userId,
      ROOT,
      platform: rec.platform,
      goal: rec.goal,
      claimedAtMs,
    });
  }
}

async function main(): Promise<void> {
  const ROOT = getStorageRoot();
  console.log(
    `[Worker] clipify-worker started | STORAGE_ROOT=${ROOT} | pid=${process.pid}`
  );

  for (;;) {
    try {
      await tick(ROOT);
    } catch (err) {
      console.error("[Worker] tick error:", err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

void main();
