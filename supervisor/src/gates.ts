// supervisor/src/gates.ts — trust gates (PHASE-PLAN 3.1, SPEC §4.4 + §4.2).
//
// Commands (SPEC §4.4 grammar):
//   @shift-supervisor approve <task-id> / rollback <task-id> / hold <task-id>
//   (optional free-text after the task id = the recorded reason)
//
// Rules:
//   - the receipts block in the PR body is validated against crew/receipt.schema.md;
//     any missing/incomplete field ⇒ needs-eyes post naming the exact gaps.
//   - approve counts ONLY when the task's PR has CI green at read time;
//     anything else → refusal reply with the current CI state.
//   - a receipt that says FAIL can never merge (§4.2).
//   - rollback = close the open PR (git revert of the merge commit if it
//     already merged) + ledger record + room post "rolled back: <reason>".
//   - hold = the PR stays draft, i.e. the needs-eyes state, recorded.
//
// The typed command is the machine truth (docs delta: reaction events do not
// reach agents — one of the three recorded P0 docs deltas).

import { appendFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec.js";
import type { CiState } from "./prs.js";
import type { Config } from "./env.js";
import { SUPERVISOR_DIR } from "./env.js";

// ---- 1. gate command grammar (§4.4) ------------------------------------------

export type GateVerb = "approve" | "rollback" | "hold";

export interface GateCommand {
  verb: GateVerb;
  taskId: string;
  /** Optional free text after the task id (the "rolled back: <reason>" slot). */
  reason: string | null;
}

const GATE_RE = /^(approve|rollback|hold)\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+([\s\S]*))?$/;

/** Parse one addressed human message into a gate command, or null.
 *  Leading @mentions (any handle shape, per §4.4 "@shift-supervisor …") are
 *  skipped — but everything else must match the exact verb-first grammar. */
export function parseGateCommand(body: string): GateCommand | null {
  let text = String(body ?? "").trim();
  while (true) {
    const m = /^@([A-Za-z0-9][A-Za-z0-9._/-]*)(\s+([\s\S]*))?$/.exec(text);
    if (!m) break;
    text = (m[3] ?? "").trim();
  }
  const m = GATE_RE.exec(text);
  if (!m) return null;
  const verb = m[1] as GateVerb;
  const taskId = (m[2] ?? "").trim();
  const reason = (m[3] ?? "").trim() || null;
  if (!taskId) return null;
  return { verb, taskId, reason };
}

// ---- 2. receipts-block validator (crew/receipt.schema.md) ----------------------

export const RECEIPT_FIELDS = [
  "summary",
  "files-touched",
  "tests",
  "test-log",
  "risk-call",
  "deviations",
  "budget",
] as const;

export type ReceiptFieldName = (typeof RECEIPT_FIELDS)[number];

export interface ParsedReceiptBlock {
  found: boolean;
  /** Raw values in the order they appeared in the block. */
  fields: Partial<Record<ReceiptFieldName, string>>;
  /** Field names in the order they appeared (for the schema order check). */
  order: ReceiptFieldName[];
  /** Raw tail content between the test-log fences ("" when none). */
  testLogBody: string;
  incompleteFence?: boolean;
}

/** Pull the receipts block for `taskId` out of a PR body (the schema's "last
 *  non-empty block", located by `#### receipts — <task-id>`). Field values sit
 *  after the colon, except test-log whose RAW tail lives between the fences. */
export function parseReceiptBlock(prBody: string, taskId: string): ParsedReceiptBlock {
  const lines = String(prBody ?? "").split("\n");
  const start = lines.findIndex((l) => l.trim() === `#### receipts — ${taskId}`);
  if (start === -1) return { found: false, fields: {}, order: [], testLogBody: "" };

  // the block ends at the next receipts header (defensive: there is only one)
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").includes("#### receipts")) {
      end = i;
      break;
    }
  }

  const fields: Partial<Record<ReceiptFieldName, string>> = {};
  const order: ReceiptFieldName[] = [];
  let testLogBody = "";
  // test-log state machine: field line → open fence → raw tail → close fence
  let testLogState: "off" | "awaiting_fence" | "capturing" = "off";
  const fieldRe = /^\s*-\s*([a-z][a-z-]*):\s*(.*)$/;

  for (let i = start + 1; i < end; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (testLogState === "capturing") {
      if (trimmed === "```") {
        testLogState = "off";
        continue;
      }
      testLogBody += (testLogBody === "" ? "" : "\n") + line;
      continue;
    }
    if (testLogState === "awaiting_fence") {
      if (trimmed === "```") {
        testLogState = "capturing";
        continue;
      }
      // no fence opened — the value after the colon is prose, not raw tail;
      // keep parsing fields normally (validation flags the empty tail)
      testLogState = "off";
      continue;
    }
    const m = fieldRe.exec(line);
    if (m) {
      const name = m[1] as ReceiptFieldName;
      if (RECEIPT_FIELDS.includes(name)) {
        order.push(name);
        fields[name] = (m[2] ?? "").trim();
        if (name === "test-log") testLogState = "awaiting_fence";
      }
    }
  }
  return { found: true, fields, order, testLogBody, incompleteFence: testLogState !== "off" };
}

export interface ReceiptCheck {
  ok: boolean;
  /** Exact gaps, ready to paste into the needs-eyes post. */
  gaps: string[];
  testPass: boolean | null;
  riskLevel: "low" | "medium" | "high" | null;
  declaredDeviations: boolean;
  filesTouched: string[] | null;
  budgetSpent: number | null;
  budgetCap: number | null;
}

export interface ReceiptContract {
  taskId: string;
  filesAllowed: readonly string[];
  budgetMinutes: number;
}

/** Validate a PR body's receipts block against the schema + the slip's own
 *  contract (files_allowed whitelist, budget). `gaps` names every problem
 *  exactly — the room post pastes them verbatim. */
export function validateReceiptBlock(prBody: string, contract: ReceiptContract): ReceiptCheck {
  const gaps: string[] = [];
  const out: ReceiptCheck = {
    ok: false,
    gaps,
    testPass: null,
    riskLevel: null,
    declaredDeviations: false,
    filesTouched: null,
    budgetSpent: null,
    budgetCap: contract.budgetMinutes,
  };

  const block = parseReceiptBlock(prBody, contract.taskId);
  if (!block.found) {
    gaps.push(`receipts block for ${contract.taskId} not found in the PR body`);
    return out;
  }

  // every required field present and non-empty (test-log is field-line +
  // fenced-tail: handled right after)
  for (const f of RECEIPT_FIELDS) {
    if (f === "test-log") continue;
    const v = block.fields[f];
    if (v === undefined || v === "") gaps.push(`missing field: ${f}`);
  }

  // test-log: the field line must exist AND its fenced tail must be non-empty
  if (block.fields["test-log"] === undefined) {
    gaps.push("missing field: test-log");
  } else if (block.testLogBody.trim() === "") {
    gaps.push("test-log fenced block is empty — the RAW runner tail must be inside it");
  }

  if (block.incompleteFence) gaps.push("test-log fenced block is not closed");

  // tests: literally PASS or FAIL
  const tests = block.fields["tests"];
  if (tests !== undefined && tests !== "") {
    if (tests === "PASS" || tests === "FAIL") out.testPass = tests === "PASS";
    else gaps.push(`tests must be literally PASS or FAIL (got: "${tests}")`);
  }

  // files-touched: whitelist check against the slip (skip when the contract
  // could not be extracted from the PR body — never flag what we can't know)
  const filesLine = block.fields["files-touched"];
  if (filesLine !== undefined && filesLine !== "") {
    if (/^none outside files_allowed$/i.test(filesLine)) {
      out.filesTouched = [];
    } else {
      const files = filesLine.split(",").map((s) => s.trim()).filter(Boolean);
      out.filesTouched = files;
      if (contract.filesAllowed.length > 0) {
        const outside = files.filter((f) => !contract.filesAllowed.includes(f));
        if (outside.length > 0) {
          gaps.push(`files-touched names path(s) outside the slip's files_allowed: ${outside.join(", ")}`);
        }
      }
    }
  }

  // risk-call: low | medium | high — one sentence why
  const risk = block.fields["risk-call"];
  if (risk !== undefined && risk !== "") {
    const m = /^(low|medium|high)\s*[—–:\-]\s*(\S.{2,})$/.exec(risk);
    if (m) out.riskLevel = m[1] as "low" | "medium" | "high";
    else gaps.push(`risk-call must start with low|medium|high and say why (got: "${risk}")`);
  }

  // deviations: literally "none", or the declared bullet list (honesty, not silence)
  const dev = block.fields["deviations"];
  if (dev !== undefined && dev !== "") {
    out.declaredDeviations = !/^none$/i.test(dev);
  }

  // budget: <spent> / <budget> min
  const budget = block.fields["budget"];
  if (budget !== undefined && budget !== "") {
    const m = /^(\d+)\s*\/\s*(\d+)\s*min$/.exec(budget);
    if (m) {
      out.budgetSpent = Number(m[1]);
      out.budgetCap = Number(m[2]);
      if (out.budgetCap > 0 && out.budgetSpent > out.budgetCap) {
        gaps.push(`budget exceeded: spent ${out.budgetSpent} > ${out.budgetCap} min`);
      }
    } else {
      gaps.push(`budget must be "<spent> / <budget> min" (got: "${budget}")`);
    }
  }

  // schema field order (crew/receipt.schema.md: out of order ⇒ incomplete)
  const got = block.order;
  const expected = RECEIPT_FIELDS.filter((f) => got.includes(f));
  if (got.length > 0 && got.join(",") !== expected.join(",")) {
    gaps.push(`field order wrong: ${got.join(", ")} (expected ${expected.join(", ")})`);
  }

  out.ok = gaps.length === 0;
  return out;
}

// ---- 3. the decision core (pure; the unit-test table) --------------------------

export interface GateInputs {
  verb: GateVerb;
  taskId: string;
  ciState: CiState;
  ciDetail: string;
  receipt: ReceiptCheck;
  /** Task has a known open PR in the registry. */
  hasOpenPr: boolean;
}

export type GateAction =
  | "merge"
  | "rollback"
  | "hold"
  | "refuse_ci"
  | "refuse_receipt"
  | "unknown_task"
  | "unknown_pr";

export interface GateDecision {
  action: GateAction;
  reply: string;
}

/** The whole gate table in one pure function (verify target: approve without
 *  CI green is rejected here, among everything else). */
export function decideGate(inputs: GateInputs): GateDecision {
  const { verb, taskId, ciState, ciDetail, receipt, hasOpenPr } = inputs;

  if (verb === "rollback") {
    if (!hasOpenPr) {
      return mk(
        "unknown_pr",
        `⛔ rollback **${taskId}** refused — the PR could not be read right now; nothing was changed. Try again.`,
      );
    }
    return mk("rollback", "");
  }

  if (verb === "hold") {
    if (!hasOpenPr) {
      return mk(
        "unknown_pr",
        `⏸ hold **${taskId}** refused — the PR could not be read right now; try again.`,
      );
    }
    return mk("hold", heldPost(taskId));
  }

  // verb === "approve"
  if (!hasOpenPr) {
    return mk(
      "unknown_pr",
      `⛔ approve **${taskId}** refused — the PR could not be read right now; refusing blind. Try again.`,
    );
  }
  if (receipt.gaps.length > 0) {
    return mk("refuse_receipt", needsEyesPost(taskId, receipt.gaps));
  }
  if (receipt.testPass === false) {
    return mk("refuse_receipt", failReceiptPost(taskId));
  }
  if (ciState !== "green") {
    return mk("refuse_ci", ciRefusalPost(taskId, ciState, ciDetail));
  }
  return mk("merge", "");

  function mk(action: GateAction, reply: string): GateDecision {
    return { action, reply };
  }
}

// ---- 4. room post builders -----------------------------------------------------

export function needsEyesPost(taskId: string, gaps: string[]): string {
  return (
    `👀 needs-eyes — receipt for **${taskId}** is incomplete; PR stays draft:\n` +
    gaps.map((g) => `- ${g}`).join("\n") +
    `\nFix the receipts block and say it again.`
  );
}

export function ciRefusalPost(taskId: string, ciState: CiState, detail: string): string {
  return (
    `⛔ approve **${taskId}** refused — CI state: **${ciState}** (${detail}).\n` +
    `approve counts only with CI green at read time (SPEC §4.4).`
  );
}

export function failReceiptPost(taskId: string): string {
  return `⛔ approve **${taskId}** refused — the receipt says tests: FAIL. A receipt can never merge with FAIL (§4.2).`;
}

export function heldPost(taskId: string): string {
  return `⏸ **${taskId}** held — the PR stays draft; nothing merges until you approve it later.`;
}

export function rolledBackPost(taskId: string, reason: string, actedOnBranch: boolean): string {
  return `♻️ rolled back: ${reason || "human asked for rollback"} — ${actedOnBranch ? "PR closed + branch deleted" : "no branch touched"} · recorded in the ledger.`;
}

export function unknownTaskPost(taskId: string): string {
  return `❓ no open task **${taskId}** is registered in tonight's ledger — nothing to gate.`;
}

export function mergedPost(taskId: string, prNumber: number | null, prUrl: string | null): string {
  return `✅ **${taskId}** approved — receipts clean, CI green. Merged PR #${prNumber ?? "?"}${prUrl ? ` (${prUrl})` : ""}. Receipts filed, human signed off.`;
}

// ---- 5. gh plumbing (envOverride exists ONLY for unit tests) --------------------

export interface PrStateRead {
  body: string | null;
  state: "OPEN" | "DRAFT" | "MERGED" | "CLOSED" | null;
  isDraft: boolean;
  ci: { state: CiState; detail: string };
  mergeCommit: string | null;
}

/** One `gh pr view` gives body + state + CI rollup + merge sha. */
export async function readPrState(cwd: string, prNumber: number, envOverride?: NodeJS.ProcessEnv): Promise<PrStateRead | null> {
  const view = await exec(
    "gh",
    ["pr", "view", String(prNumber), "--json", "body,state,isDraft,statusCheckRollup,mergeCommit"],
    cwd,
    60_000,
    { env: envOverride },
  );
  if (!view.ok) return null;
  try {
    const j = JSON.parse(view.output) as {
      body?: string;
      state?: PrStateRead["state"];
      isDraft?: boolean;
      statusCheckRollup?: { status?: string; conclusion?: string }[];
      mergeCommit?: { oid?: string };
    };
    return {
      body: j.body ?? "",
      state: j.state ?? null,
      isDraft: Boolean(j.isDraft),
      ci: rollup(j.statusCheckRollup ?? []),
      mergeCommit: j.mergeCommit?.oid ?? null,
    };
  } catch {
    return null;
  }
}

function rollup(checks: { status?: string; conclusion?: string }[]): { state: CiState; detail: string } {
  if (checks.length === 0) return { state: "none", detail: "no checks recorded" };
  const pending = checks.some((c) => c.status === "IN_PROGRESS" || c.status === "QUEUED" || c.status === "PENDING");
  const failed = checks.some((c) => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT" || c.conclusion === "CANCELLED");
  const allDone = checks.every((c) => c.status === "COMPLETED");
  if (failed) return { state: "red", detail: `${checks.length} checks, failures present` };
  if (!allDone || pending) return { state: "pending", detail: `${checks.length} checks, still running` };
  return {
    state: checks.every((c) => c.conclusion === "SUCCESS") ? "green" : "red",
    detail: `${checks.length} checks`,
  };
}

/** Approve path: undraft the PR, then merge it (--merge, no squash per repo
 *  norm "shift branches land via GitHub merge"). */
export async function mergePr(cwd: string, prNumber: number, envOverride?: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  const ready = await exec("gh", ["pr", "ready", String(prNumber)], cwd, 60_000, { env: envOverride });
  if (!ready.ok) return { ok: false, output: `gh pr ready failed: ${ready.output.slice(-300)}` };
  const merged = await exec("gh", ["pr", "merge", String(prNumber), "--merge"], cwd, 120_000, { env: envOverride });
  if (!merged.ok) return { ok: false, output: `gh pr merge failed: ${merged.output.slice(-300)}` };
  return { ok: true, output: merged.output };
}

/** Rollback path for an OPEN/DRAFT PR: close it + delete its remote branch. */
export async function closePr(cwd: string, prNumber: number, branch: string, envOverride?: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  const close = await exec("gh", ["pr", "close", String(prNumber)], cwd, 60_000, { env: envOverride });
  if (!close.ok) return { ok: false, output: `gh pr close failed: ${close.output.slice(-300)}` };
  const del = await exec("git", ["push", "origin", "--delete", branch], cwd, 60_000, { env: envOverride });
  const output = `closed PR #${prNumber}${del.ok ? "" : `; branch delete failed: ${del.output.slice(-200)}`}`;
  return { ok: del.ok, output };
}

/** Rollback path for an already-MERGED PR: revert the merge commit on main. */
export async function revertMergedPr(cwd: string, prNumber: number, mergeCommit: string, envOverride?: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  // gh pr revert opens a revert PR; it does not land the revert itself.
  const proposed = await exec("gh", ["pr", "revert", String(prNumber)], cwd, 120_000, { env: envOverride });
  if (proposed.ok) {
    const url = proposed.output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (!url) return { ok: false, output: "revert PR created but its URL was not returned; review GitHub before retrying" };
    return exec("gh", ["pr", "merge", url, "--merge"], cwd, 120_000, { env: envOverride });
  }
  // Work in isolation: a rollback must never revert on a worker's branch.
  const status = await exec("git", ["fetch", "origin", "main"], cwd, 60_000, { env: envOverride });
  if (!status.ok) return status;
  const scratch = join(mkdtempSync(join(tmpdir(), "nightshift-revert-")), "worktree");
  const add = await exec("git", ["worktree", "add", "--detach", scratch, "origin/main"], cwd, 60_000, { env: envOverride });
  if (!add.ok) return add;
  try {
    const reverted = await exec("git", ["revert", "-m", "1", "--no-edit", mergeCommit], scratch, 120_000, { env: envOverride });
    if (!reverted.ok) return reverted;
    return await exec("git", ["push", "origin", "HEAD:main"], scratch, 120_000, { env: envOverride });
  } finally {
    await exec("git", ["worktree", "remove", "--force", scratch], cwd, 60_000, { env: envOverride });
  }
}

// ---- 6. the open-task registry (ledger.jsonl is the machine truth) --------------

export interface OpenTask {
  taskId: string;
  branch: string;
  prNumber: number;
  prUrl: string | null;
}

type LedgerLine = Record<string, unknown> & { refs?: Record<string, unknown> };

function ledgerPath(): string {
  return process.env.LEDGER_PATH ?? join(SUPERVISOR_DIR, "ledger.jsonl");
}

export function appendGateEvent(type: string, refs: Record<string, unknown>, note?: string): void {
  try {
    const entry = {
      ts: new Date().toISOString(),
      actor: "shift-supervisor",
      type,
      refs,
      ...(note ? { note } : {}),
    };
    appendFileSync(ledgerPath(), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // best-effort: ledger failure must not break the gate reply
  }
}

export function rebuildOpenTasks(ledgerFile: string): Map<string, OpenTask> {
  const out = new Map<string, OpenTask>();
  let text = "";
  try {
    text = readFileSync(ledgerFile, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: LedgerLine;
    try {
      e = JSON.parse(t) as LedgerLine;
    } catch {
      continue;
    }
    const taskId = typeof e.taskId === "string" ? e.taskId : (typeof e.refs?.task === "string" ? (e.refs.task as string) : null);
    if (!taskId) continue;
    const prNumber = typeof e.prNumber === "number" ? e.prNumber : (typeof e.refs?.pr === "number" ? (e.refs.pr as number) : null);
    const type = typeof e.type === "string" ? e.type : "";
    if (type === "gate_result") {
      const status = e.refs?.status;
      if (status === "merged" || status === "rolled_back") {
        out.delete(taskId);
        continue;
      }
    }
    const branch = typeof e.branch === "string" ? e.branch : (typeof e.refs?.branch === "string" ? (e.refs.branch as string) : null);
    if (prNumber !== null && branch) {
      const blocked = e.blocked === true;
      if (blocked) continue;
      out.set(taskId, {
        taskId,
        branch,
        prNumber,
        prUrl: typeof e.prUrl === "string" ? e.prUrl : null,
      });
    }
  }
  return out;
}

// ---- 7. the runtime gate executor -----------------------------------------------

export interface GateRuntime {
  cfg: Config;
  client: { postMessage: (roomId: string, content: string) => Promise<boolean> };
  roomId: string;
  registry: Map<string, OpenTask>;
  /** by: who commanded (human handle in the room id or plain label). */
  by?: string;
}

/** Execute one parsed gate command: validate receipts → decide → gh action →
 *  room post → ledger event → registry update. Never throws. */
export async function handleGateCommand(
  rt: GateRuntime,
  gate: GateCommand,
  opts: { envOverride?: NodeJS.ProcessEnv; log?: (...a: unknown[]) => void } = {},
): Promise<GateDecision> {
  const log = opts.log ?? (() => {});
  let task = rt.registry.get(gate.taskId) ?? null;
  // Successful merges leave the open registry but remain rollback candidates.
  if (!task && gate.verb === "rollback") {
    try {
      const entries = readFileSync(ledgerPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line) as LedgerLine);
      for (const e of entries.reverse()) {
        if (e.taskId === gate.taskId && typeof e.prNumber === "number" && typeof e.branch === "string") {
          task = { taskId: gate.taskId, prNumber: e.prNumber, branch: e.branch, prUrl: typeof e.prUrl === "string" ? e.prUrl : null };
          break;
        }
      }
    } catch { /* unknown task reply below */ }
  }

  // unknown task → honest post, no ledger event (nothing happened)
  if (!task) {
    const d: GateDecision = { action: "unknown_task", reply: unknownTaskPost(gate.taskId) };
    await rt.client.postMessage(rt.roomId, d.reply);
    log(`gate ${gate.verb} ${gate.taskId}: unknown task`);
    return d;
  }

  const pr = await readPrState(rt.cfg.targetDir, task.prNumber, opts.envOverride);
  const receipt = validateReceiptBlock(pr?.body ?? "", {
    taskId: gate.taskId,
    filesAllowed: collectFilesAllowed(pr?.body ?? ""),
    budgetMinutes: inferBudgetMinutes(pr?.body ?? ""),
  });
  // A negotiated second PR may only land after the first merge and a fresh
  // rebase/test receipt. The normal gate still checks its own CI at read time.
  if (gate.verb === "approve") {
    const orderedGap = await orderedLandingGap(gate.taskId, task.branch, rt.cfg.targetDir, opts.envOverride);
    if (orderedGap) {
      const reply = `👀 needs-eyes — ${gate.taskId} waits for ordered landing: ${orderedGap}`;
      appendGateEvent("needs_eyes", { task: gate.taskId, why: orderedGap });
      await rt.client.postMessage(rt.roomId, reply);
      return { action: "refuse_receipt", reply };
    }
  }
  const decision = decideGate({
    verb: gate.verb,
    taskId: gate.taskId,
    ciState: pr?.ci.state ?? "pending",
    ciDetail: pr?.ci.detail ?? "PR read failed",
    receipt,
    hasOpenPr: Boolean(task) && pr !== null,
  });

  let extraPost: string | null = null;
  if (decision.action === "merge") {
    const merged = await mergePr(rt.cfg.targetDir, task.prNumber, opts.envOverride);
    if (merged.ok) {
      extraPost = mergedPost(gate.taskId, task.prNumber, task.prUrl);
      appendGateEvent("gate_result", { task: gate.taskId, gate: "approved", by: rt.by ?? "human", ci: "green", status: "merged" });
      appendGateEvent("merge", { task: gate.taskId, pr: task.prNumber });
      rt.registry.delete(gate.taskId);
    } else {
      extraPost = `⛔ approve **${gate.taskId}** could not merge: ${merged.output.slice(0, 300)}\nThe PR stays draft; nothing has merged.`;
      appendGateEvent("error", { task: gate.taskId, gate: "approve", why: merged.output.slice(0, 200) });
      decision.action = "refuse_ci";
      decision.reply = ciRefusalPost(gate.taskId, "pending", "merge command failed");
    }
  } else if (decision.action === "rollback") {
    let rolled: { ok: boolean; output: string };
    if (pr?.state === "MERGED") {
      rolled = pr.mergeCommit
        ? await revertMergedPr(rt.cfg.targetDir, task.prNumber, pr.mergeCommit, opts.envOverride)
        : { ok: false, output: "merged PR has no mergeCommit to revert" };
    } else {
      rolled = await closePr(rt.cfg.targetDir, task.prNumber, task.branch, opts.envOverride);
    }
    const reason = gate.reason ?? "human commanded rollback";
    if (rolled.ok) {
      extraPost = rolledBackPostFor(gate.taskId, reason, task.prNumber, pr?.state === "MERGED");
      appendGateEvent("rollback", { task: gate.taskId, pr: task.prNumber, why: reason });
      appendGateEvent("gate_result", { task: gate.taskId, gate: "rolled_back", by: rt.by ?? "human", ci: pr?.ci.state ?? "unknown", status: "rolled_back", reason });
      rt.registry.delete(gate.taskId);
    } else {
      extraPost = `⛔ rollback **${gate.taskId}** failed: ${rolled.output.slice(0, 300)}\nNothing changed; try again.`;
      appendGateEvent("error", { task: gate.taskId, gate: "rollback", why: rolled.output.slice(0, 200) });
      decision.reply = extraPost;
    }
  } else if (decision.action === "hold") {
    if (pr?.state !== "OPEN") {
      decision.action = "unknown_pr";
      decision.reply = `⛔ hold **${gate.taskId}** refused — PR is ${pr?.state ?? "unknown"}.`;
    } else if (!pr.isDraft) {
      const draft = await exec("gh", ["pr", "ready", String(task.prNumber), "--undo"], rt.cfg.targetDir, 60_000, { env: opts.envOverride });
      if (!draft.ok) {
        decision.action = "unknown_pr";
        decision.reply = `⛔ hold **${gate.taskId}** could not restore draft: ${draft.output.slice(-200)}`;
      }
    }
    if (decision.action === "hold") appendGateEvent("gate_result", { task: gate.taskId, gate: "hold", by: rt.by ?? "human", ci: pr?.ci.state ?? "unknown", status: "held" });
  } else if (decision.action === "refuse_receipt") {
    if (receipt.testPass === false) {
      appendGateEvent("gate_result", { task: gate.taskId, gate: "approve_refused_fail", by: rt.by ?? "human", ci: pr?.ci.state ?? "unknown", status: "refused" }, "a receipt can never merge with FAIL");
    } else {
      appendGateEvent("needs_eyes", { task: gate.taskId, why: receipt.gaps.slice(0, 6) }, "receipt gaps → needs-eyes");
    }
  } else if (decision.action === "refuse_ci") {
    appendGateEvent("gate_result", { task: gate.taskId, gate: "approve_refused_ci", by: rt.by ?? "human", ci: ciStateLabel(pr?.ci.state ?? "pending"), status: "refused" }, "approve honored only after CI green");
  }

  const reply = extraPost ?? verdictReply(gate, decision.action, decision.reply, receipt);
  await rt.client.postMessage(rt.roomId, reply);

  log(`gate ${gate.verb} ${gate.taskId} → ${decision.action}`);
  return { ...decision, reply };
}

function verdictReply(
  gate: GateCommand,
  action: GateAction,
  decided: string,
  receipt: ReceiptCheck,
): string {
  if (action === "merge") return `⏳ approving **${gate.taskId}** — receipts clean, CI green at read time…`;
  if (decided) return decided;
  return `gate ${gate.verb} ${gate.taskId}: no verdict (receipt ok: ${receipt.ok})`;
}

function rolledBackPostFor(taskId: string, reason: string, prNumber: number | null, wasMerged: boolean): string {
  return (
    `♻️ rolled back: ${reason}\n` +
    `${taskId}: ${wasMerged ? "merge reverted on main" : `PR #${prNumber ?? "?"} closed · branch deleted`} · recorded in the ledger.`
  );
}

function ciStateLabel(s: CiState): string {
  return s;
}

// ---- receipts contract helpers ---------------------------------------------------

/** The slip contract is IN the PR body (renderPrBody writes the files
 *  whitelist + the budget); extracting it keeps gates honest about what the
 *  slip asked for at gate-time, not just at PR-open time. */
export function collectFilesAllowed(prBody: string): string[] {
  const out: string[] = [];
  const lines = String(prBody ?? "").split("\n");
  const start = lines.findIndex((l) => l.includes("Files allowed by the slip:"));
  if (start !== -1) {
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^-\s*`(.+)`/.exec(lines[i] ?? "");
      if (!m) break;
      const f = m[1];
      if (!f) break;
      out.push(f);
    }
  }
  return out;
}

export function inferBudgetMinutes(prBody: string): number {
  const m = /^- budget:\s*(\d+)\s*\/\s*(\d+)\s*min/m.exec(String(prBody ?? ""));
  return m ? Number(m[2]) : 0;
}

/** Refuse the second negotiated merge until the first has landed and this
 * branch includes the new main. A post-rebase receipt event proves retest. */
export async function orderedLandingGap(taskId: string, branch: string, cwd: string, envOverride?: NodeJS.ProcessEnv): Promise<string | null> {
  let entries: LedgerLine[];
  try { entries = readFileSync(ledgerPath(), "utf8").split("\n").filter(Boolean).map(x => JSON.parse(x) as LedgerLine); }
  catch { return null; }
  const result = [...entries].reverse().find(e => e.type === "negotiation_result" && Array.isArray(e.refs?.agreed_order) && e.refs.agreed_order[1] === taskId);
  if (!result) return null;
  const first = (result.refs?.agreed_order as string[])[0];
  const merged = [...entries].reverse().find(e => e.type === "gate_result" && e.refs?.task === first && e.refs?.status === "merged" && String(e.ts) > String(result.ts));
  if (!merged) return `${first} has not merged yet`;
  const refreshed = [...entries].reverse().find(e => e.type === "receipt_ok" && e.refs?.task === taskId && e.refs?.after_rebase === true && e.refs?.validated === true && String(e.ts) > String(merged.ts));
  if (!refreshed) return "the second PR has no post-rebase test receipt";
  const fetched = await exec("git", ["fetch", "--quiet", "origin"], cwd, 60_000, { env: envOverride });
  if (!fetched.ok) return `cannot refresh branch refs: ${fetched.output.slice(-120)}`;
  const base = await exec("git", ["merge-base", "origin/main", `origin/${branch}`], cwd, 60_000, { env: envOverride });
  const main = await exec("git", ["rev-parse", "origin/main"], cwd, 60_000, { env: envOverride });
  if (!base.ok || !main.ok || base.output.trim() !== main.output.trim()) return "second branch must rebase onto current main";
  return null;
}
