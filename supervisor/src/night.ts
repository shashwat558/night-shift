// supervisor/src/night.ts — the budgeted night.
//
// Contract:
//   - process up to N slips sequentially (NIGHT_MAX_SLIPS; extra slips are
//     skipped with an honest "capped" reason — never silently dropped)
//   - each slip gets a wall-clock deadline = its time_budget_minutes +
//     a grace window (the grace covers PR-open/test-collection, which the
//     spawner's own budget kill-switch does not span)
//   - on deadline fire: the slip is marked BLOCKED with the reason, its room
//     post + ledger record go out, and the night CONTINUES with the next slip
//     (after settling the orphaned work so two git runs never overlap)
//
// The spawner's per-run kill (SIGTERM/SIGKILL at the provider budget) remains
// the primary killer for the worker process itself; this module is the outer
// timer that bounds the WHOLE slip (provider + push + PR + tests) and the
// sequential flow that keeps going afterwards.

import type { Slip } from "./slips.js";

export interface NightLimits {
  /** Max number of slips processed per night. */
  maxSlips: number;
  /** Extra milliseconds after the slip budget before the deadline fires. */
  graceMs: number;
}

export const DEFAULT_MAX_SLIPS = 5;
export const DEFAULT_GRACE_MS = 3 * 60_000;

export function readNightLimits(rawEnv: Record<string, string> = {}): NightLimits {
  const n = Number(rawEnv.NIGHT_MAX_SLIPS ?? "");
  const gRaw = rawEnv.NIGHT_GRACE_MS;
  return {
    maxSlips: Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_SLIPS,
    graceMs: gRaw === undefined || gRaw === "" ? DEFAULT_GRACE_MS : clampGrace(Number(gRaw)),
  };
}

function clampGrace(g: number): number {
  if (!Number.isFinite(g) || g < 0) return DEFAULT_GRACE_MS;
  return Math.min(Math.max(Math.floor(g), 5_000), 30 * 60_000);
}

export type SlipStatus = "done" | "blocked" | "deadline" | "error" | "capped";

export interface SlipOutcome {
  taskId: string;
  status: SlipStatus;
  reason: string | null;
}

export interface NightPlan {
  take: Slip[];
  capped: { slip: Slip; ordinal: number }[];
}

/** Apply the N-slip cap: the first N slips run; the rest are capped. */
export function planNight(slips: Slip[], limits: NightLimits): NightPlan {
  const take = slips.slice(0, Math.max(0, limits.maxSlips));
  const capped = slips.slice(Math.max(0, limits.maxSlips)).map((slip, i) => ({
    slip,
    ordinal: take.length + i + 1,
  }));
  return { take, capped };
}

/** Deadline for one slip: its own budget + grace. */
export function slipDeadlineMs(slip: Slip, limits: NightLimits): number {
  return slip.time_budget_minutes * 60_000 + limits.graceMs;
}

export interface ExtendedWork {
  /** The underlying per-slip promise (never rejected). */
  p: Promise<unknown>;
  /** Stop child processes and prevent subsequent PR side effects. */
  cancel?: () => void;
}

export interface ExtendedOutcome {
  result: unknown;
  timedOut: boolean;
}

/** Race one slip's work against its wall-clock deadline. Never throws.
 *  On fire: `result` is null, `timedOut` true — the caller posts the block,
 *  and continues; to avoid overlapping git runs the work promise is awaited
 *  up to `settleMs` more (real work always settles: the spawner's own budget
 *  kill + bounded exec timeouts). */
export async function raceSlipDeadline(
  work: ExtendedWork,
  deadlineMs: number,
  settleMs = 90_000,
): Promise<ExtendedOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    work.p.then((value: unknown) => ({ fired: false as const, value })),
    new Promise<{ fired: true; value: null }>((resolve) => {
      timer = setTimeout(() => resolve({ fired: true, value: null }), deadlineMs);
    }),
  ]);
  clearTimeout(timer);
  if (!result.fired) return { result: result.value, timedOut: false };
  work.cancel?.();

  // deadline fired: give the work one bounded settle window (its own kill
  // switches complete collection), then stop waiting either way
  await Promise.race([
    work.p.then(() => true),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), settleMs);
      t.unref?.();
    }),
  ]);
  return { result: null, timedOut: true };
}

export interface NightRunHooks {
  log: (...a: unknown[]) => void;
  /** Room post per capped slip (skip notice). Async to match postMessage. */
  onCapped?: (slip: Slip, ordinal: number) => Promise<void>;
  /** Room post + ledger for a deadline-blocked slip. */
  onDeadline?: (slip: Slip, deadlineMin: number) => Promise<void>;
  /** Called before each processed slip. */
  onStart?: (slip: Slip, ordinal: number) => Promise<void>;
}

export interface NightResult {
  outcomes: SlipOutcome[];
  processed: number;
  capped: number;
  deadlineBlocked: number;
}

/** The budgeted night: N slips, sequential, per-slip deadline, continue on
 *  timeout. `workOf` builds each slip's run; every outcome is one of done /
 *  blocked / deadline / error / capped. Never throws. */
export async function runBudgetedNight(
  slips: Slip[],
  limits: NightLimits,
  workOf: (slip: Slip) => ExtendedWork,
  hooks: NightRunHooks &
    /** Extract the outcome from the settled work (status + reason). */
    { outcomeOf: (slip: Slip, result: unknown) => { status: SlipStatus; reason: string | null } },
): Promise<NightResult> {
  const { outcomeOf, ...runHooks } = hooks;
  const plan = planNight(slips, limits);
  const outcomes: SlipOutcome[] = [];
  let deadlineBlocked = 0;

  let ordinal = 0;
  for (const slip of plan.take) {
    ordinal += 1;
    try {
      await runHooks.onStart?.(slip, ordinal);
    } catch {
      // ignore
    }
    const work = workOf(slip);
    const deadlineMs = slipDeadlineMs(slip, limits);
    const wait = await raceSlipDeadline(work, deadlineMs);
    if (wait.timedOut) {
      deadlineBlocked += 1;
      const deadlineMin = Math.round(deadlineMs / 60_000);
      outcomes.push({
        taskId: slip.id,
        status: "deadline",
        reason: `slip deadline ${deadlineMin}min (budget ${slip.time_budget_minutes}min + grace) — worker stopped, night continues`,
      });
      try {
        await runHooks.onDeadline?.(slip, deadlineMin);
      } catch {
        // posting must never kill the night
      }
      continue;
    }
    const st = outcomeOf(slip, wait.result);
    outcomes.push({ taskId: slip.id, status: st.status, reason: st.reason });
  }

  // capped slips are posted + recorded AFTER the processed ones, so the
  // outcome list reads in the order the night actually claimed work
  for (const c of plan.capped) {
    outcomes.push({ taskId: c.slip.id, status: "capped", reason: `night cap ${limits.maxSlips} — not claimed tonight` });
    try {
      await runHooks.onCapped?.(c.slip, c.ordinal);
    } catch {
      // posting must never kill the night
    }
  }

  void runHooks.log;
  return {
    outcomes,
    processed: plan.take.length,
    capped: plan.capped.length,
    deadlineBlocked,
  };
}

/** The post-night roster for the room: outcomes in order with honest marks,
 *  one line each. */
export function nightRosterPost(heading: string, outcomes: SlipOutcome[]): string {
  const marks: Record<SlipStatus, string> = {
    done: "✅",
    blocked: "🚫",
    deadline: "⏰",
    error: "⚠️",
    capped: "🛏",
  };
  const lines = outcomes.map(
    (o) => `${marks[o.status]} \`${o.taskId}\` — ${o.status}${o.reason ? ` (${o.reason})` : ""}`,
  );
  return [heading, ...lines].join("\n");
}
