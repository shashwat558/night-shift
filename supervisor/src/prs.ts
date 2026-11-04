// supervisor/src/prs.ts — the PR side: receipts block (§4.2), draft PR via
// gh, and the CI status read.
//
// The receipts block is the worker's own account of the run. The supervisor
// assembles it this way (recorded reality — the worker is a headless child
// process):
//   - the provider is ASKED to print its own receipts block (its summary,
//     risk-call, deviations — parsed out verbatim when present)
//   - the supervisor overlays the parts it owns from real runs: files-touched
//     (actual diff), tests + test-log (actual npm test exit + raw tail),
//     budget (actual measured minutes)
//   - anything the provider did not supply keeps an honest placeholder —
//     phase-3 gates turn receipt gaps into needs-eyes posts

import { exec } from "./exec.js";
import type { Slip } from "./slips.js";

export interface ProviderReceiptAttempt {
  summary?: string;
  riskCall?: string;
  deviations?: string;
  budgetClaimed?: string;
  found: boolean;
}

/** A trimmed view of the spawner's run that prs.ts cares about. */
export interface RunFacts {
  filesTouched: string[];
  testPass: boolean | null;
  testOutput: string;
  startedAt: number;
  finishedAt?: number;
  timedOut: boolean;
  providerOutput: string;
}

/** Pull the provider's own receipts block out of its output, if present. */
export function parseProviderReceipt(output: string, taskId: string): ProviderReceiptAttempt {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.includes("#### receipts") && l.includes(taskId));
  if (start === -1) return { found: false };
  const out: ProviderReceiptAttempt = { found: true };
  const field = (name: string): string | undefined => {
    for (let i = start + 1; i < Math.min(lines.length, start + 24); i++) {
      const m = new RegExp(`^\\s*-\\s*${name}:\\s*(.+)$`).exec(lines[i] ?? "");
      if (m) return (m[1] ?? "").trim() || undefined;
    }
    return undefined;
  };
  out.summary = field("summary");
  out.riskCall = field("risk-call");
  out.deviations = field("deviations");
  out.budgetClaimed = field("budget");
  return out;
}

/** The exact §4.2 block renderer — same field order as crew/receipt.schema.md. */
export function renderReceipts(slip: Slip, wip: RunFacts, attempt: ProviderReceiptAttempt = { found: false }): string {
  const measured = wip.finishedAt ? Math.max(1, Math.round((wip.finishedAt - wip.startedAt) / 60000)) : 0;
  const spent = wip.timedOut ? slip.time_budget_minutes : measured;
  const filesLine = wip.filesTouched.length === 0 ? "none outside files_allowed" : wip.filesTouched.join(", ");
  const deviations = attempt.deviations && attempt.deviations !== "" ? attempt.deviations : "none";
  const summary = attempt.summary && attempt.summary !== "" ? attempt.summary : slip.title;
  const risk = attempt.riskCall && attempt.riskCall !== "" ? attempt.riskCall : "unfiled — headless run produced no risk statement";
  return [
    `#### receipts — ${slip.id}`,
    `- summary: ${summary}`,
    `- files-touched: ${filesLine}`,
    `- tests: ${wip.testPass === true ? "PASS" : "FAIL"}`,
    `- test-log:`,
    "```",
    rawTestLogTailRef(wip.testOutput),
    "```",
    `- risk-call: ${risk}`,
    `- deviations: ${deviations}`,
    `- budget: ${spent} / ${slip.time_budget_minutes} min`,
  ].join("\n");
}

// local import of the raw-tail builder (single source in spawner.ts)
import { rawTestLogTail as rawTestLogTailRef } from "./spawner.js";

/** The PR body: summary + the receipts block (the block is last, per schema). */
export function renderPrBody(
  slip: Slip,
  receiptsBlock: string,
  prMeta: { ghRepo: string | null; provider: string },
): string {
  return [
    `## ${slip.title}`,
    ``,
    `Backlog ref: ${slip.backlog_ref}  |  Task id: \`${slip.id}\`  |  Branch: \`shift/${slip.id}\`  |  Worker provider: \`${prMeta.provider}\`${prMeta.ghRepo ? `  |  Repo: ${prMeta.ghRepo}` : ""}`,
    ``,
    `Scope (from the taskslip):`,
    `> ${slip.scope}`,
    ``,
    `Files allowed by the slip:`,
    ...slip.files_allowed.map((f) => `- \`${f}\``),
    ``,
    `Acceptance:`,
    ...slip.acceptance.map((a) => `- ${a}`),
    ``,
    `Opened draft by the night-shift supervisor — merges only after the human's typed gate command with CI green.`,
    receiptsBlock,
    "",
  ].join("\n");
}

// ---- gh plumbing -------------------------------------------------------------

export interface PrResult {
  ok: boolean;
  prUrl: string | null;
  prNumber: number | null;
  output: string;
}

/** Push the branch + open a draft PR with the receipts block. Never throws.
 *  envOverride exists ONLY for unit tests (fake gh on PATH). */
export async function createDraftPr(
  cwd: string,
  slip: Slip,
  wip: RunFacts,
  opts: { provider: string; ghRepo: string | null; title?: string; envOverride?: NodeJS.ProcessEnv },
): Promise<PrResult> {
  const envOpt = opts.envOverride;
  const push = await exec("git", ["push", "-q", "--force-with-lease", "-u", "origin", `shift/${slip.id}`], cwd, 120_000, { env: envOpt });
  if (!push.ok) {
    return { ok: false, prUrl: null, prNumber: null, output: `push failed: ${push.output}` };
  }
  const attempt = parseProviderReceipt(wip.providerOutput, slip.id);
  const body = renderPrBody(slip, renderReceipts(slip, wip, attempt), {
    ghRepo: opts.ghRepo,
    provider: opts.provider,
  });
  const create = await exec(
    "gh",
    [
      "pr",
      "create",
      "--draft",
      "--title",
      opts.title ?? `${slip.id}: ${slip.title}`,
      "--body",
      body,
      "--base",
      "main",
      "--head",
      `shift/${slip.id}`,
    ],
    cwd,
    120_000,
    { env: envOpt },
  );
  if (!create.ok) {
    return { ok: false, prUrl: null, prNumber: null, output: `gh pr create failed: ${create.output}` };
  }
  const urlMatch = /https:\/\/github\.com\/[\w./-]+\/pull\/\d+/.exec(create.output);
  const num = urlMatch ? Number(/pull\/(\d+)$/.exec(urlMatch[0])?.[1] ?? 0) : null;
  return { ok: true, prUrl: urlMatch ? urlMatch[0] : null, prNumber: num || null, output: create.output };
}

export type CiState = "green" | "red" | "pending" | "none";

/** Combined check state (`gh pr view --json statusCheckRollup`). */
export async function ciStatus(
  cwd: string,
  prNumber: number,
  envOverride?: NodeJS.ProcessEnv,
): Promise<{ state: CiState; detail: string }> {
  const view = await exec("gh", ["pr", "view", String(prNumber), "--json", "statusCheckRollup"], cwd, 60_000, { env: envOverride });
  if (!view.ok) return { state: "pending", detail: `gh pr view failed: ${view.output.slice(0, 160)}` };
  try {
    const parsed = JSON.parse(view.output) as {
      statusCheckRollup?: { status?: string; conclusion?: string }[];
    };
    const roll = parsed.statusCheckRollup ?? [];
    if (roll.length === 0) return { state: "none", detail: "no checks recorded" };
    const pending = roll.some((c) => c.status === "IN_PROGRESS" || c.status === "QUEUED" || c.status === "PENDING");
    const failed = roll.some((c) => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT" || c.conclusion === "CANCELLED");
    const allDone = roll.every((c) => c.status === "COMPLETED");
    if (failed) return { state: "red", detail: `${roll.length} checks, failures present` };
    if (!allDone || pending) return { state: "pending", detail: `${roll.length} checks, still running` };
    const green = roll.every((c) => c.conclusion === "SUCCESS");
    return { state: green ? "green" : "pending", detail: `${roll.length} checks` };
  } catch (e) {
    return { state: "pending", detail: `unparseable status: ${String(e).slice(0, 100)}` };
  }
}
