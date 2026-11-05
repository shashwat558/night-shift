// test/goals.test.ts — goal detection + the 2-phase slips watch, offline with
// a real tmpfs repoRoot and short injected timeouts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { GOAL_PREFIX_RE, goalText, isGoal, slipsFileCandidates, watchForSlips } from "../src/goals.js";

const TMP = "/tmp/opencode/nightshift-goals-tests";
const BASE = "/tmp/opencode";
void TMP;

test("goal grammar", () => {
  assert.equal(isGoal("tonight: implement BACKLOG item 1"), true);
  assert.equal(isGoal("  TONIGHT: Lisa needs it by 9am"), true, "case-insensitive");
  assert.equal(isGoal("@nightshift-night-lead please start"), false);
  assert.equal(isGoal("@shift-supervisor tonight: implement BACKLOG 2"), true);
  assert.equal(goalText("@shift-supervisor tonight: implement BACKLOG 2"), "implement BACKLOG 2");
  assert.equal(isGoal("the meeting tonight: pizza"), false);
  assert.equal(GOAL_PREFIX_RE.test("tonight: x"), true);
  assert.equal(goalText("tonight: implement NEXT-1"), "implement NEXT-1");
});

test("slips file candidates: today + tomorrow, YYYY-MM-DD", () => {
  const root = "/repo";
  const c = slipsFileCandidates(root, new Date(2026, 10, 3, 21, 30)); // 2026-11-03 21:30 local
  assert.deepEqual(
    c.map((p) => p.replace(/\\/g, "/")),
    ["/repo/crew/taskslips/2026-11-03.yml", "/repo/crew/taskslips/2026-11-04.yml"],
  );
  const midnightRun = slipsFileCandidates(root, new Date(2026, 10, 3, 23, 58));
  assert.deepEqual(
    midnightRun.map((p) => p.replace(/\\/g, "/")),
    ["/repo/crew/taskslips/2026-11-03.yml", "/repo/crew/taskslips/2026-11-04.yml"],
  );
});

test("phase A: file appears late → clean parse wins", async () => {
  const root = await mkdtemp(join(BASE, "watch-"));
  try {
    await fs.mkdir(join(root, "crew"), { recursive: true });
    const watcher = watchForSlips(root, { phaseATimeoutMs: 1500, phaseBTimeoutMs: 1500, pollIntervalMs: 40 });
    // 60ms later: night-lead creates the slips dir + writes the file
    setTimeout(async () => {
      await fs.mkdir(join(root, "crew", "taskslips"), { recursive: true });
      await fs.writeFile(
        join(root, "crew", "taskslips", slipsFileCandidates(root)[0]!.split("/").pop()!),
        validSlips(),
      );
    }, 60);
    const r = await watcher;
    assert.equal(r.appeared, true);
    const parse = r.parse as { ok: boolean; errors?: string[]; slips: { id: string }[] } | null;
    assert.equal(parse?.ok, true, JSON.stringify(parse?.errors ?? []));
    assert.equal(parse?.slips[0]?.id, "B-20261103-01");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("phase B: mid-write garbage settles into a clean parse", async () => {
  const root = await mkdtemp(join(BASE, "watch-"));
  try {
    await fs.mkdir(join(root, "crew", "taskslips"), { recursive: true });
    const path = slipsFileCandidates(root)[0] as string;
    const watcher = watchForSlips(root, { phaseATimeoutMs: 1500, phaseBTimeoutMs: 2000, pollIntervalMs: 40 });
    // night-lead writes a broken file then completes it
    setTimeout(async () => {
      await fs.writeFile(path, "slips:\n  - id: B-20261103-01\n    backlog_ref: BA");
    }, 40);
    setTimeout(async () => {
      await fs.writeFile(path, validSlips());
    }, 200);
    const r = await watcher;
    assert.equal((r.parse as { ok: boolean }).ok, true, JSON.stringify((r.parse as { errors?: string[] })?.errors ?? []));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deadline without a file → appeared:false (supervisor blocks)", async () => {
  const root = await mkdtemp(join(BASE, "watch-"));
  try {
    const r = await watchForSlips(root, { phaseATimeoutMs: 250, phaseBTimeoutMs: 1500, pollIntervalMs: 40 });
    assert.equal(r.appeared, false);
    assert.equal(r.parse, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that stays dirty surfaces the parser's exact errors", async () => {
  const root = await mkdtemp(join(BASE, "watch-"));
  try {
    await fs.mkdir(join(root, "crew", "taskslips"), { recursive: true });
    const path = slipsFileCandidates(root)[0] as string;
    const watcher = watchForSlips(root, { phaseATimeoutMs: 300, phaseBTimeoutMs: 500, pollIntervalMs: 40 });
    setTimeout(async () => {
      await fs.writeFile(
        path,
        `slips:
  - id: B-20261103-01
    backlog_ref: BACKLOG-1
    title: t
    assignee: shift-worker-1
    scope: s
    files_allowed: []
    acceptance:
      - works
    time_budget_minutes: 300
`,
      );
    }, 40);
    const r = await watcher;
    assert.equal(r.appeared, true);
    assert.equal((r.parse as { ok: boolean }).ok, false);
    assert.match((r.parse as { errors: string[] }).errors.join(" "), /time_budget_minutes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function validSlips(): string {
  return `slips:
  - id: B-20261103-01
    backlog_ref: BACKLOG-1
    title: Add input validation to POST /pets
    assignee: shift-worker-1
    scope: >-
      Validate POST /pets body: name required non-empty string.
      Return 400 JSON on invalid.
    files_allowed:
      - src/routes/pets.js
    acceptance:
      - POST /pets with empty name returns 400
      - existing tests still pass
    time_budget_minutes: 20
`;
}

void rm;
