export type Plan = "free" | "pro" | "power";

export interface PlanConfig {
  minutesPerMonth: number;
  label: string;
}

export const PLAN_LIMITS: Record<Plan, PlanConfig> = {
  free: { minutesPerMonth: 30, label: "Free" },
  pro: { minutesPerMonth: 1000, label: "Pro" },
  power: { minutesPerMonth: 3000, label: "Power" },
};

export function getPlanLimit(plan: Plan): number {
  return PLAN_LIMITS[plan]?.minutesPerMonth ?? PLAN_LIMITS.free.minutesPerMonth;
}

export function getPlanLabel(plan: Plan): string {
  return PLAN_LIMITS[plan]?.label ?? "Free";
}

export function normalizePlan(raw: unknown): Plan {
  if (raw === "pro") return "pro";
  if (raw === "power") return "power";
  return "free";
}

/** Consistent Pro upgrade / positioning copy across UI and usage-limit messages */
export const PRO_POSITIONING = {
  tagline: "Built for active podcasters and creators",
  coreIdea:
    "Pro is the main paid plan for people posting consistently and using Clipify as a real workflow.",
  valuePitch:
    "Enough capacity for a real weekly workflow, more freedom to regenerate and explore clips, designed for consistent posting and growth, and room to refine every clip until it hits.",
} as const;

/** Power tier — use for Upgrade to Power tooltips and Power-specific CTAs (not Pro copy) */
export const POWER_POSITIONING = {
  tagline: "Built for high-volume creators and teams",
  valuePitch:
    "More monthly capacity for clip pages, agencies, large backlogs, and heavy weekly workflows.",
} as const;
