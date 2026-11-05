// Deterministic 9 AM report, replayed only from the append-only ledger.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendEvent, entriesSinceLastReport, ledgerPath, readLedger, taskIdOf, type LedgerLine } from "./ledger.js";

interface Attempt {
  taskId: string;
  worker: string;
  prUrl: string | null;
  prNumber: number | null;
  testPass: boolean | null;
  blocked: boolean;
  reason: string | null;
  spentMin: number | null;
  budgetMin: number | null;
}

export interface ReportArtifact {
  content: string;
  file: string;
  relativeFile: string;
  reused: boolean;
  eventCount: number;
}

const asString = (v: unknown): string | null => typeof v === "string" ? v : null;
const asNumber = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

export function reportDate(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function renderShiftReport(allEntries: LedgerLine[], date: string, invalidLines = 0): string {
  const entries = entriesSinceLastReport(allEntries);
  const attempts = new Map<string, Attempt>();
  for (const e of entries) {
    if (typeof e.taskId !== "string" || typeof e.branch !== "string") continue;
    attempts.set(e.taskId, {
      taskId: e.taskId,
      worker: asString(e.worker) ?? "unassigned",
      prUrl: asString(e.prUrl),
      prNumber: asNumber(e.prNumber),
      testPass: typeof e.testPass === "boolean" ? e.testPass : null,
      blocked: e.blocked === true,
      reason: asString(e.reason),
      spentMin: asNumber(e.spentMin),
      budgetMin: asNumber(e.budgetMin),
    });
  }

  const merged = new Map<string, number | null>();
  const rolled = new Map<string, string>();
  const blocked = new Map<string, string>();
  const needsEyes = new Map<string, string>();
  const held = new Set<string>();
  for (const e of entries) {
    const task = taskIdOf(e);
    if (!task) continue;
    if (e.type === "merge") merged.set(task, asNumber(e.refs?.pr));
    if (e.type === "rollback") rolled.set(task, asString(e.refs?.why) ?? asString(e.refs?.reason) ?? "reason not recorded");
    if (e.type === "block") blocked.set(task, asString(e.refs?.why) ?? "block reason not recorded");
    if (e.type === "needs_eyes") {
      const why = e.refs?.why;
      needsEyes.set(task, Array.isArray(why) ? why.map(String).join("; ") : asString(why) ?? "receipt review required");
    }
    if (e.type === "gate_result") {
      if (e.refs?.status === "rolled_back") rolled.set(task, asString(e.refs?.reason) ?? rolled.get(task) ?? "reason not recorded");
      if (e.refs?.status === "held") held.add(task);
    }
  }
  for (const a of attempts.values()) {
    if (a.blocked && !blocked.has(a.taskId)) blocked.set(a.taskId, a.reason ?? "worker run blocked");
  }

  const workerRows = new Map<string, Attempt[]>();
  for (const a of attempts.values()) {
    const rows = workerRows.get(a.worker) ?? [];
    rows.push(a);
    workerRows.set(a.worker, rows);
  }

  const lines = [
    `# Night Shift report — ${date}`,
    "",
    `Merged: **${merged.size}** · Rolled back: **${rolled.size}** · Blocked: **${blocked.size}** · Needs eyes: **${needsEyes.size}**`,
    "",
    "## Merged",
    ...listMap(merged, (task, pr) => {
      const a = attempts.get(task);
      const label = a?.prUrl ? `[PR #${pr ?? a.prNumber ?? "?"}](${a.prUrl})` : `PR #${pr ?? a?.prNumber ?? "?"}`;
      return `- \`${task}\` — ${label}`;
    }),
    "",
    "## Rolled back",
    ...listMap(rolled, (task, why) => `- \`${task}\` — ${why}`),
    "",
    "## Blocked",
    ...listMap(blocked, (task, why) => `- \`${task}\` — ${why}`),
    "",
    "## Needs eyes",
    ...listMap(needsEyes, (task, why) => `- \`${task}\` — ${why}`),
    "",
    "## Worker stats",
    "| Worker | Done | Rollbacks | Avg budget | Trust |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...[...workerRows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([worker, rows]) => {
      const done = rows.filter(r => r.testPass === true && !r.blocked).length;
      const rollbacks = rows.filter(r => rolled.has(r.taskId)).length;
      const budgetRows = rows.filter(r => r.spentMin !== null);
      const avg = budgetRows.length ? `${trimNumber(budgetRows.reduce((n, r) => n + (r.spentMin ?? 0), 0) / budgetRows.length)} min` : "—";
      const score = Math.round(rows.reduce((n, r) => n + trustPoints(r, merged, rolled, blocked, needsEyes, held), 0) / rows.length);
      return `| ${worker} | ${done} | ${rollbacks} | ${avg} | ${score}/100 |`;
    }),
    ...(workerRows.size ? [] : ["| — | 0 | 0 | — | — |"]),
    "",
    `Tonight's recommendation: ${recommendation(blocked.size, needsEyes.size, rolled.size)}`,
    "",
    "Trust formula: merged 100; held, pending, or needs-eyes 50; rolled back, blocked, or failed tests 0; average per recorded task.",
    ...(invalidLines > 0 ? [`Ledger warning: ${invalidLines} malformed line(s) were ignored.`] : []),
    "",
  ];
  return lines.join("\n");
}

function listMap<T>(map: Map<string, T>, render: (task: string, value: T) => string): string[] {
  return map.size ? [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([task, value]) => render(task, value)) : ["- none"];
}

function trustPoints(a: Attempt, merged: Map<string, unknown>, rolled: Map<string, unknown>, blocked: Map<string, unknown>, needs: Map<string, unknown>, held: Set<string>): number {
  if (rolled.has(a.taskId) || blocked.has(a.taskId) || a.testPass === false) return 0;
  if (merged.has(a.taskId)) return 100;
  if (needs.has(a.taskId) || held.has(a.taskId)) return 50;
  return 50;
}

function recommendation(blocked: number, needs: number, rolled: number): string {
  if (blocked > 0) return "reduce scope or increase budgets for blocked slips before adding more work.";
  if (needs > 0) return "fix receipt gaps before adding more work.";
  if (rolled > 0) return "review rollback causes before the next shift.";
  return "keep the current scopes and gate policy for the next shift.";
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export function createReportArtifact(repoRoot: string, now = new Date(), ledgerFile = ledgerPath()): ReportArtifact {
  const { entries, invalidLines } = readLedger(ledgerFile);
  const date = reportDate(now);
  const reportDir = join(repoRoot, "docs", "reports");
  const file = join(reportDir, `${date}.md`);
  const relativeFile = relative(repoRoot, file).replaceAll("\\", "/");
  const window = entriesSinceLastReport(entries);
  const lastReport = [...entries].reverse().find(e => e.type === "report_posted");
  const lastFile = asString(lastReport?.refs?.file);
  if (window.length === 0 && lastFile === relativeFile && existsSync(file)) {
    return { content: readFileSync(file, "utf8"), file, relativeFile, reused: true, eventCount: 0 };
  }
  const content = renderShiftReport(entries, date, invalidLines);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(file, content, { mode: 0o600 });
  return { content, file, relativeFile, reused: false, eventCount: window.length };
}

export async function publishShiftReport(
  repoRoot: string,
  trigger: "clock" | "cli" | "room",
  post: (content: string) => Promise<boolean>,
  now = new Date(),
  ledgerFile = ledgerPath(),
): Promise<ReportArtifact> {
  const artifact = createReportArtifact(repoRoot, now, ledgerFile);
  if (artifact.reused) return artifact;
  const posted = await post(artifact.content);
  if (!posted) throw new Error("report room post failed");
  appendEvent("report_posted", { file: artifact.relativeFile, trigger, events: artifact.eventCount }, undefined, ledgerFile);
  return artifact;
}
