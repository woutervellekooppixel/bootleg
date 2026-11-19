import { BUDGET_MIN, BUDGET_RAMP_DAYS, BUDGET_START, BUDGET_STEP } from "./config.ts";
import { getState, nowIso, setState } from "./db.ts";
import { loadSettings } from "./settings.ts";

const bounds = () => {
  const max = loadSettings().maxPerNight;
  return { min: Math.min(BUDGET_MIN, max), max };
};

/** Current searches per night, and since when it has been at this level without a captcha. */
export function budgetState(): { budget: number; since: string; max: number } {
  const { min, max } = bounds();
  const stored = Number(getState("budget") ?? BUDGET_START);
  const budget = Math.max(min, Math.min(max, Number.isFinite(stored) ? stored : BUDGET_START));
  let since = getState("budget_since");
  if (!since) {
    since = nowIso();
    setState("budget", String(budget));
    setState("budget_since", since);
  }
  return { budget, since, max };
}

/** At the start of a night: after a week without a captcha, raise the pace. */
export function budgetForTonight(log: (s: string) => void = () => {}): number {
  const { budget, since, max } = budgetState();
  const days = (Date.now() - new Date(since).getTime()) / 86_400_000;
  if (days >= BUDGET_RAMP_DAYS && budget < max) {
    const next = Math.min(max, budget + BUDGET_STEP);
    setState("budget", String(next));
    setState("budget_since", nowIso());
    log(`A week without a captcha: ${budget} → ${next} photos per night`);
    return next;
  }
  return budget;
}

/** After a captcha: halve the pace and start the week again. */
export function budgetAfterCaptcha(): number {
  const { min } = bounds();
  const { budget } = budgetState();
  const next = Math.max(min, Math.floor(budget / 2 / 10) * 10);
  setState("budget", String(next));
  setState("budget_since", nowIso());
  return next;
}
