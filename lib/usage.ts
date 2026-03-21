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

export async function canUserProcess(
  userId: string,
  videoDurationMinutes: number
): Promise<{ allowed: boolean; message?: string; usage: UserUsage }> {
  const usage = await getUserUsage(userId);

  if (videoDurationMinutes > usage.minutesRemaining) {
    return {
      allowed: false,
      message: `You have ${Math.round(usage.minutesRemaining)} minutes remaining this month; this video is ${Math.round(videoDurationMinutes)} minutes long. ${PRO_POSITIONING.coreIdea} ${PRO_POSITIONING.tagline} — ${PRO_POSITIONING.valuePitch} Upgrade for more monthly capacity, or wait until your usage resets next month.`,
      usage,
    };
  }

  return { allowed: true, usage };
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
