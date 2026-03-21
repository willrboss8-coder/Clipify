import type { Plan } from "./plans";

/** Pro users get one viral-caption burn; tracked in Clerk privateMetadata */
export const VIRAL_TRIAL_FLAG_KEY = "viralCaptionsProTrialUsed" as const;

export type ViralCaptionAccess =
  | "none" /** Free — no access */
  | "trial" /** Pro — one use remaining */
  | "exhausted" /** Pro — trial already used */
  | "full"; /** Power — unlimited */

export function getViralCaptionAccess(
  plan: Plan,
  proTrialUsed: boolean
): ViralCaptionAccess {
  if (plan === "power") return "full";
  if (plan === "free") return "none";
  if (plan === "pro") return proTrialUsed ? "exhausted" : "trial";
  return "none";
}

export function proTrialUsedFromPrivateMetadata(
  privateMetadata: Record<string, unknown> | undefined
): boolean {
  return privateMetadata?.[VIRAL_TRIAL_FLAG_KEY] === true;
}

