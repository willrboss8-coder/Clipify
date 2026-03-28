import { logE2E } from "@/lib/e2e-timing";
import { recordUsage, type ProcessingBudget } from "@/lib/usage";
import { readJobRecord, writeJobRecord, patchJobRecord } from "@/lib/jobStore";
import type { ProcessResponse } from "@/lib/types/clip-job";

export async function runFinalizeStage(params: {
  jobId: string;
  userId: string;
  budget: ProcessingBudget;
  pendingResult: Omit<ProcessResponse, "usage">;
}): Promise<number> {
  const { jobId, userId, budget, pendingResult } = params;

  const updatedUsage = await recordUsage(userId, budget.effectiveScanMinutes);
  if (pendingResult.clips.length > 0) {
    console.log(
      `[Job ${jobId}] Remaining minutes after job: ${updatedUsage.minutesRemaining.toFixed(2)}`
    );
  }

  const result: ProcessResponse = {
    ...pendingResult,
    usage: {
      minutesUsed: updatedUsage.minutesUsed,
      minutesLimit: updatedUsage.minutesLimit,
      minutesRemaining: updatedUsage.minutesRemaining,
    },
  };

  const latest = await readJobRecord(jobId);
  if (!latest) return 0;

  const tSave = performance.now();
  await writeJobRecord(
    patchJobRecord(latest, {
      status: "completed",
      result,
      stage: "finalized",
    })
  );
  logE2E(jobId, "render_finalize_finished");
  return (performance.now() - tSave) / 1000;
}
