import { auth } from "@clerk/nextjs/server";
import { readJobRecord } from "@/lib/jobStore";

export const JOB_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MultipartGuardResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; message: string };

/**
 * Same rules as POST /api/process/upload-url: signed-in, job exists, owned, awaiting_upload.
 */
export async function requireAwaitingUploadJob(
  jobId: string
): Promise<MultipartGuardResult> {
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  if (!jobId || !JOB_ID_UUID_RE.test(jobId)) {
    return { ok: false, status: 400, message: "Missing or invalid jobId" };
  }
  const rec = await readJobRecord(jobId);
  if (!rec) {
    return { ok: false, status: 404, message: "Not found" };
  }
  if (rec.userId !== userId) {
    return { ok: false, status: 404, message: "Not found" };
  }
  if (rec.status !== "awaiting_upload") {
    return {
      ok: false,
      status: 409,
      message:
        "Job is not waiting for upload (wrong status or upload already completed).",
    };
  }
  return { ok: true, userId };
}
