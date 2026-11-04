// supervisor/src/spawner.ts — the headless coder runs (SPEC §2: `claude -p` /
// `opencode run` child processes in target/; decision D1: opencode default).
//
// Flow per slip:
//   1. require a CLEAN target worktree (never mix the crew's work with
//      uncommitted dirt; abort with a reason instead of stashing)
//   2. `git fetch --quiet origin` + `git checkout -B shift/<id> origin/main`
//      (branches always from origin/main)
//   3. run the provider headless in target/ with the slip verbatim + the
//      receipt requirements + the files_allowed hard whitelist
//   4. budget kill-switch: SIGTERM at the budget, SIGKILL 5s later, the run
//      is marked blocked with the reason
//   5. collect the truth: files changed (git diff --name-only
//      origin/main...HEAD), the full diff, and a REAL test run (npm test)
//      whose raw output tail becomes the receipt's test-log
//
// The provider is a child process. It never posts to the room.

import { spawn } from "node:child_process";
import { exec, type ExecResult } from "./exec.js";
import type { Slip } from "./slips.js";
import type { Config } from "./env.js";

export interface WipRun {
  slip: Slip;
  branch: string;
  blocked: boolean;
  reason?: string;
  providerOutput: string;
  providerExitCode: number | null;
  timedOut: boolean;
  startedAt: number;
  finishedAt?: number;
  filesTouched: string[];
  diff: string;
  testOutput: string;
  testPass: boolean | null;
}

/** The provider's prompt: slip verbatim + receipt rules + hard scope. */
export function providerPrompt(slip: Slip, budgetMin?: number): string {
  const budget = budgetMin ?? slip.time_budget_minutes;
  const lines = [
    `You are a headless coding worker on branch shift/${slip.id} of the petshop repo (your current directory).`,
    `You have ${budget} minutes wall-clock; stop before the budget and report.`,
    ``,
    `TASKSLIP (verbatim):`,
    `  id: ${slip.id}`,
    `  backlog_ref: ${slip.backlog_ref}`,
    `  title: ${slip.title}`,
    `  scope: ${slip.scope}`,
    `  files_allowed (hard whitelist — you may create or edit ONLY these relative paths):`,
    ...slip.files_allowed.map((p) => `    - ${p}`),
    `  acceptance criteria (each must hold):`,
    ...slip.acceptance.map((a) => `    - ${a}`),
    ...(slip.notes ? [`  notes: ${slip.notes}`] : []),
    ``,
    `RULES:`,
    `  - Touch NOTHING outside files_allowed. If you believe another file must change, STOP and say so instead of doing it.`,
    `  - COMMIT your work on the current branch (git add only files_allowed paths, then git commit) BEFORE printing the receipts block.`,
    `  - Run the test suite (npm test) after your change. Your claims must come from real runs.`,
    `  - FINISH by printing a receipts block EXACTLY in this shape, using YOUR real numbers:`,
    `    ` + "```",
    `    #### receipts — ${slip.id}`,
    `    - summary: <one line what changed>`,
    `    - files-touched: <comma list of paths you actually touched>`,
    `    - tests: PASS | FAIL   (the exit of npm test)`,
    `    - test-log: (the raw runner output is supplied by the supervisor; note here only where it sits)`,
    `    - risk-call: low | medium | high — one sentence why`,
    `    - deviations: none | bullet list of every step the slip did not authorize`,
    `    - budget: <minutes spent> / ${budget} min`,
    `    ` + "```",
    `  - If you cannot even start, print: receipt rejected: <one line why>`,
  ];
  return lines.join("\n");
}

/** The provider CLI contract (decision D1 + provider abstraction): */
export function providerArgs(provider: "opencode" | "claude", prompt: string): string[] | null {
  if (provider === "opencode") return ["run", prompt];
  if (provider === "claude") return ["-p", prompt];
  return null;
}

/** Run one worker for one slip. Returns the run facts; never throws.
 *  budgetMsOverride exists ONLY for unit tests (offline determinism). */
export async function runWorker(
  cfg: Config,
  slip: Slip,
  log: (...a: unknown[]) => void,
  opts: { budgetMsOverride?: number } = {},
): Promise<WipRun> {
  const args = providerArgs(cfg.provider, providerPrompt(slip));
  const wip: WipRun = {
    slip,
    branch: `shift/${slip.id}`,
    blocked: false,
    providerOutput: "",
    providerExitCode: null,
    timedOut: false,
    startedAt: Date.now(),
    filesTouched: [],
    diff: "",
    testOutput: "",
    testPass: null,
  };
  if (!args) {
    return { ...wip, blocked: true, reason: `unknown provider ${cfg.provider}` };
  }

  // 1. clean-worktree check (never steal the crew's uncommitted work)
  const status = await exec("git", ["status", "--porcelain"], cfg.targetDir);
  if (!status.ok) {
    return { ...wip, blocked: true, reason: `git status failed in target/: ${status.output.slice(-200)}` };
  }
  if (status.output.trim() !== "") {
    return {
      ...wip,
      blocked: true,
      reason: `target/ worktree not clean — refusing to start ${slip.id} on top of uncommitted changes`,
    };
  }

  // 2. branch from origin/main
  const fetchRes = await exec("git", ["fetch", "--quiet", "origin"], cfg.targetDir, 60_000);
  if (!fetchRes.ok) {
    return { ...wip, blocked: true, reason: `git fetch origin failed: ${fetchRes.output.slice(-300)}` };
  }
  const checkout = await exec("git", ["checkout", "-q", "-B", wip.branch, "origin/main"], cfg.targetDir);
  if (!checkout.ok) {
    return { ...wip, blocked: true, reason: `git checkout -B ${wip.branch} origin/main failed: ${checkout.output.slice(-300)}` };
  }
  log(`worker on branch ${wip.branch} (${cfg.provider}) for ${slip.id}`);

  // 3. the provider run, budget kill-switch armed
  const providerResult = await runProviderWithBudget(cfg.provider, args, slip, cfg.targetDir, log, opts.budgetMsOverride);

  // 4. collect the truth regardless of provider exit (git ops are ours)
  const nameStatus = await exec("git", ["diff", "--name-only", "origin/main...HEAD"], cfg.targetDir);
  wip.filesTouched = nameStatus.output.split("\n").map((s) => s.trim()).filter(Boolean);
  const diff = await exec("git", ["diff", "origin/main...HEAD"], cfg.targetDir);
  wip.diff = diff.ok ? diff.output : "";

  wip.providerExitCode = providerResult.exitCode;
  wip.timedOut = providerResult.timedOut;
  if (providerResult.timedOut) {
    wip.blocked = true;
    wip.reason = `budget ${slip.time_budget_minutes}min exceeded — worker killed`;
  } else if (providerResult.exitCode !== 0) {
    wip.blocked = true;
    wip.reason = `provider exited ${providerResult.exitCode ?? "?"}: ${providerResult.output.slice(-300)}`;
  } else {
    wip.providerOutput = providerResult.output;
  }

  // 5. the real test run — the receipt's test-log tail; exit rules PASS/FAIL
  const test: ExecResult = await exec("npm", ["test"], cfg.targetDir, 120_000);
  wip.testOutput = (test.output || "").trim();
  wip.testPass = test.ok;
  wip.finishedAt = Date.now();
  return wip;
}

async function runProviderWithBudget(
  provider: string,
  args: string[],
  slip: Slip,
  cwd: string,
  log: (...a: unknown[]) => void,
  budgetMsOverride?: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  let output = "";
  const budgetMs = budgetMsOverride ?? slip.time_budget_minutes * 60_000;

  const result = await new Promise<{ exitCode: number | null; output: string; timedOut: boolean }>((resolve) => {
    // detached + process-group kill: a provider CLI that shells out must not
    // be able to outlive its budget via grandchildren holding the pipes
    const child = spawn(provider, args, { cwd, env: process.env, detached: true });
    let done = false;
    let timedOut = false;
    let hardKill: NodeJS.Timeout | null = null;

    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (hardKill) clearTimeout(hardKill);
      clearTimeout(lastResort);
      resolve({ exitCode: code, output: output.slice(-40_000), timedOut });
    };

    const deadline = setTimeout(() => {
      if (done) return;
      timedOut = true;
      log(`budget kill: ${slip.id} exceeded ${slip.time_budget_minutes}min — SIGTERM (pgid ${child.pid ?? "?"})`);
      if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch {}
      hardKill = setTimeout(() => {
        if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 5000);
      hardKill.unref?.();
    }, budgetMs);
    deadline.unref?.();
    // paranoid belt: if stream teardown stalls past the kill window,
    // resolve anyway with what we captured (blocked + timedOut stands)
    const lastResort = setTimeout(() => finish(null), budgetMs + 6500);
    lastResort.unref?.();

    child.stdout?.on("data", (d: Buffer) => {
      output += d.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    });
    child.stderr?.on("data", (d: Buffer) => {
      output += d.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    });
    child.stdout?.on("data", (d: Buffer) => {
      output += d.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    });
    child.stderr?.on("data", (d: Buffer) => {
      output += d.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code ?? null));
  });
  return result;
}

/** test-log tail builder: the LAST ~25 lines, raw, no paraphrase (§4.2). */
export function rawTestLogTail(testOutput: string, lines = 25): string {
  const ls = testOutput.split("\n");
  return ls.slice(Math.max(0, ls.length - lines)).join("\n");
}
