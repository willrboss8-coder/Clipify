import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { getStorageRoot } from "@/lib/storage-path";
import type { JobRecord } from "@/lib/types/clip-job";

export function getJobDir(jobId: string): string {
  return path.join(getStorageRoot(), "jobs", jobId);
}

export function getJobStatePath(jobId: string): string {
  return path.join(getJobDir(jobId), "state.json");
}

export async function writeJobRecord(record: JobRecord): Promise<void> {
  const dir = getJobDir(record.jobId);
  await mkdir(dir, { recursive: true });
  const payload: JobRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(getJobStatePath(record.jobId), JSON.stringify(payload, null, 2), "utf-8");
}

export async function readJobRecord(jobId: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(getJobStatePath(jobId), "utf-8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

export function patchJobRecord(
  prev: JobRecord,
  patch: Partial<Pick<JobRecord, "status" | "error" | "result" | "stage">>
): JobRecord {
  return {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}
