// supervisor/test/night.test.ts — the budgeted night (PHASE-PLAN 3.2): N-cap,
// per-slip deadline, block-with-reason + continue; offline, no real workers.

import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readNightLimits,
  planNight,
  slipDeadlineMs,
  raceSlipDeadline,
  runBudgetedNight,
  nightRosterPost,
  type NightLimits,
  type ExtendedWork,
} from "../src/night.js";
import type { Slip } from "../src/slips.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "nightshift-night-"));
});

function slipFixture(id: string, overrides?: Partial<Slip>): Slip {
  return {
    id,
    backlog_ref: "BACKLOG-1",
    title: `do ${id}`,
    assignee: "shift-worker-1",
    scope: "small scope",
    files_allowed: ["src/a.js"],
    acceptance: ["it works"],
    time_budget_minutes: 20,
    notes: "",
    ...overrides,
  };
}

const DEFAULTS: NightLimits = { maxSlips: 3, graceMs: 5_000 };

// ---- limits ------------------------------------------------------------------

test("readNightLimits: defaults when env is silent", () => {
  const l = readNightLimits({});
  assert.equal(l.maxSlips, 5);
  assert.equal(l.graceMs, 3 * 60_000);
});

test("readNightLimits: NIGHT_MAX_SLIPS / NIGHT_GRACE_MS honored, nonsense tolerated", () => {
  assert.equal(readNightLimits({ NIGHT_MAX_SLIPS: "3" }).maxSlips, 3);
  assert.equal(readNightLimits({ NIGHT_GRACE_MS: "10000" }).graceMs, 10_000);
  assert.equal(readNightLimits({ NIGHT_MAX_SLIPS: "banana" }).maxSlips, 5);
  assert.equal(readNightLimits({ NIGHT_MAX_SLIPS: "0" }).maxSlips, 5); // ≥1 enforced
  assert.equal(readNightLimits({ NIGHT_GRACE_MS: "200" }).graceMs, 5_000); // clamp low
  assert.equal(readNightLimits({ NIGHT_GRACE_MS: "9999999999" }).graceMs, 30 * 60_000); // clamp high
});

test("planNight: cap splits the roster; capped slips keep their ordinal", () => {
  const slips = ["B-1", "B-2", "B-3", "B-4", "B-5"].map((id) => slipFixture(id));
  const plan = planNight(slips, DEFAULTS);
  assert.deepEqual(plan.take.map((s) => s.id), ["B-1", "B-2", "B-3"]);
  assert.deepEqual(
    plan.capped.map((c) => [c.slip.id, c.ordinal]),
    [["B-4", 4], ["B-5", 5]],
  );
});

test("planNight: cap above the roster size caps nothing", () => {
  const slips = [slipFixture("B-1")];
  const plan = planNight(slips, { maxSlips: 9, graceMs: 0 });
  assert.equal(plan.take.length, 1);
  assert.equal(plan.capped.length, 0);
});

test("slipDeadlineMs = budget + grace", () => {
  assert.equal(slipDeadlineMs(slipFixture("B-1", { time_budget_minutes: 20 }), DEFAULTS), 20 * 60_000 + 5_000);
});

// ---- the deadline race ---------------------------------------------------------

function hangingWork(ms: number): ExtendedWork {
  return { p: new Promise((resolve) => setTimeout(resolve, ms)) };
}

test("raceSlipDeadline: work inside the deadline resolves normally", async () => {
  const out = await raceSlipDeadline({ p: Promise.resolve({ blocked: false }) }, 5_000, 100);
  assert.equal(out.timedOut, false);
  assert.deepEqual(out.result, { blocked: false });
});

test("raceSlipDeadline: work past the deadline fires blocked + a bounded settle wait", async () => {
  const t0 = Date.now();
  const out = await raceSlipDeadline(hangingWork(10_000), 30, 80);
  const dt = Date.now() - t0;
  assert.equal(out.timedOut, true);
  assert.equal(out.result, null);
  // waited deadline(30ms) + settle(80ms), not the full 10s hang
  assert.ok(dt < 2_000, `took ${dt}ms — settle window not bounded`);
});

// ---- the whole night ------------------------------------------------------------

test("runBudgetedNight: cap notices + rower of outcomes in order", async () => {
  const posts: string[] = [];
  const capped: string[] = [];
  const results = await runBudgetedNight(
    ["B-1", "B-2", "B-3", "B-4"].map((id) => slipFixture(id)),
    { maxSlips: 3, graceMs: 1_000 },
    (slip) => ({
      p: Promise.resolve({
        blocked: slip.id === "B-2",
        reason: slip.id === "B-2" ? "worktree dirty" : undefined,
      }),
    }),
    {
      log: () => {},
      onCapped: async (slip, ordinal) => {
        capped.push(`${slip.id}#${ordinal}`);
        posts.push(`🛏 ${slip.id} capped notice posted`);
      },
      outcomeOf: (_slip, result) => {
        const r = result as { blocked: boolean; reason?: string };
        return r.blocked
          ? { status: "blocked" as const, reason: r.reason ?? "blocked" }
          : { status: "done" as const, reason: null };
      },
    },
  );
  assert.deepEqual(
    results.outcomes.map((o) => [o.taskId, o.status]),
    [["B-1", "done"], ["B-2", "blocked"], ["B-3", "done"], ["B-4", "capped"]],
  );
  assert.deepEqual(capped, ["B-4#4"]);
  assert.equal(results.processed, 3);
  assert.equal(results.capped, 1);
  assert.equal(results.deadlineBlocked, 0);
  assert.deepEqual(posts, ["🛏 B-4 capped notice posted"]);
});

test("runBudgetedNight: deadline slip is blocked-with-reason and the night CONTINUES", async () => {
  const deadlines: string[] = [];
  const results = await runBudgetedNight(
    // budget 0min + grace 30ms ⇒ 30ms deadline: the hang misses it by a mile
    ["B-1", "B-HANG", "B-3"].map((id) => slipFixture(id, { time_budget_minutes: 0 })),
    { maxSlips: 3, graceMs: 30 },
    (slip) => (slip.id === "B-HANG" ? hangingWork(1_000) : { p: Promise.resolve({ blocked: false, reason: undefined }) }),
    {
      log: () => {},
      onDeadline: async (slip, deadlineMin) => {
        deadlines.push(`${slip.id}@${deadlineMin}min`);
      },
      outcomeOf: () => ({ status: "done" as const, reason: null }),
    },
  );
  assert.deepEqual(
    results.outcomes.map((o) => [o.taskId, o.status]),
    [["B-1", "done"], ["B-HANG", "deadline"], ["B-3", "done"]],
    `outcomes: ${JSON.stringify(results.outcomes)}`,
  );
  assert.equal(results.deadlineBlocked, 1);
  assert.equal(deadlines.length, 1);
  assert.match(deadlines[0] ?? "", /B-HANG@0min/); // 0min budget + 30ms grace
  const deadlineOutcome = results.outcomes.find((o) => o.taskId === "B-HANG");
  assert.match(deadlineOutcome?.reason ?? "", /night continues/);
});

test("runBudgetedNight: onCapped/onDeadline failures never kill the night", async () => {
  const results = await runBudgetedNight(
    ["B-1", "B-2"].map((id) => slipFixture(id, { time_budget_minutes: 1 })),
    { maxSlips: 1, graceMs: 30 },
    () => ({ p: Promise.resolve({ blocked: false, reason: undefined }) }),
    {
      log: () => {},
      onCapped: async () => {
        throw new Error("room down");
      },
      outcomeOf: () => ({ status: "done" as const, reason: null }),
    },
  );
  assert.deepEqual(
    results.outcomes.map((o) => [o.taskId, o.status]),
    [["B-1", "done"], ["B-2", "capped"]],
  );
  void base;
});

test("nightRosterPost: honest marks per status, task ids in order", () => {
  const post = nightRosterPost("🌙 Night shift complete — outcomes in order:", [
    { taskId: "B-1", status: "done", reason: null },
    { taskId: "B-2", status: "blocked", reason: "worktree dirty" },
    { taskId: "B-3", status: "deadline", reason: "slip deadline 23min — night continues" },
    { taskId: "B-4", status: "capped", reason: "night cap 3 — not claimed tonight" },
    { taskId: "B-5", status: "error", reason: "slip produced no result record" },
  ]);
  assert.ok(post.startsWith("🌙 Night shift complete"));
  assert.match(post, /✅ `B-1` — done/);
  assert.match(post, /🚫 `B-2` — blocked \(worktree dirty\)/);
  assert.match(post, /⏰ `B-3`/);
  assert.match(post, /🛏 `B-4`/);
  assert.match(post, /⚠️ `B-5`/);
});
