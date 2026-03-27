import { clerkClient } from "@clerk/nextjs/server";
import {
  normalizePlan,
  getPlanLimit,
  PRO_POSITIONING,
  type Plan,
} from "./plans";

function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

interface StoredUsage {
  minutesUsed: number;
  usagePeriod: string;
}

export interface UserUsage {
  plan: Plan;
  minutesUsed: number;
  minutesLimit: number;
  minutesRemaining: number;
  usagePeriod: string;
}

export async function getUserUsage(userId: string): Promise<UserUsage> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);

  const plan = normalizePlan(user.publicMetadata?.plan);
  const minutesLimit = getPlanLimit(plan);
  const currentPeriod = getCurrentPeriod();

  const meta = user.privateMetadata as Record<string, unknown> | undefined;
  const stored = meta?.usage as StoredUsage | undefined;

  const minutesUsed =
    stored && stored.usagePeriod === currentPeriod ? stored.minutesUsed : 0;

  return {
    plan,
    minutesUsed,
    minutesLimit,
    minutesRemaining: Math.max(0, minutesLimit - minutesUsed),
    usagePeriod: currentPeriod,
  };
}

export interface ProcessingBudget {
  usage: UserUsage;
  /** False when no minutes remain this period */
  allowed: boolean;
  /** Minutes of audio actually transcribed: min(video length, remaining) */
  effectiveScanMinutes: number;
  /** Video is longer than what we will scan (partial scan) */
  capped: boolean;
  /** When allowed is false (exhausted quota) */
  blockedMessage?: string;
}

/**
 * Decide how much of a video may be processed under the current plan.
 * When capped, only the first effectiveScanMinutes are scanned; usage is billed for that amount.
 */
export async function getProcessingBudget(
  userId: string,
  videoDurationMinutes: number
): Promise<ProcessingBudget> {
  const usage = await getUserUsage(userId);
  const remaining = usage.minutesRemaining;

  if (remaining <= 0) {
    return {
      usage,
      allowed: false,
      effectiveScanMinutes: 0,
      capped: false,
      blockedMessage: `You've used all your minutes this month. Upgrade for more capacity, or wait until your usage resets. ${PRO_POSITIONING.tagline} — ${PRO_POSITIONING.valuePitch}`,
    };
  }

  const effectiveScanMinutes = Math.min(videoDurationMinutes, remaining);
  const capped = videoDurationMinutes > remaining;

  return {
    usage,
    allowed: true,
    effectiveScanMinutes,
    capped,
  };
}

export async function recordUsage(
  userId: string,
  minutesUsed: number
): Promise<UserUsage> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);

  const currentPeriod = getCurrentPeriod();
  const meta = user.privateMetadata as Record<string, unknown> | undefined;
  const stored = meta?.usage as StoredUsage | undefined;

  const previousMinutes =
    stored && stored.usagePeriod === currentPeriod ? stored.minutesUsed : 0;

  const newMinutesUsed = previousMinutes + minutesUsed;

  await client.users.updateUserMetadata(userId, {
    privateMetadata: {
      usage: {
        minutesUsed: newMinutesUsed,
        usagePeriod: currentPeriod,
      } satisfies StoredUsage,
    },
  });

  const plan = normalizePlan(user.publicMetadata?.plan);
  const minutesLimit = getPlanLimit(plan);

  console.log(
    `[Usage] Recorded ${minutesUsed.toFixed(1)} min for user ${userId}. Total: ${newMinutesUsed.toFixed(1)}/${minutesLimit}`
  );

  return {
    plan,
    minutesUsed: newMinutesUsed,
    minutesLimit,
    minutesRemaining: Math.max(0, minutesLimit - newMinutesUsed),
    usagePeriod: currentPeriod,
  };
}
