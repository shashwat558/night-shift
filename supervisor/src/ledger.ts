// Append-only machine truth shared by gates, nights, and reports.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPERVISOR_DIR } from "./env.js";

export interface LedgerLine {
  ts?: unknown;
  actor?: unknown;
  type?: unknown;
  refs?: Record<string, unknown>;
  taskId?: unknown;
  worker?: unknown;
  branch?: unknown;
  prUrl?: unknown;
  prNumber?: unknown;
  testPass?: unknown;
  blocked?: unknown;
  reason?: unknown;
  summary?: unknown;
  filesChanged?: unknown;
  budgetMin?: unknown;
  spentMin?: unknown;
  note?: unknown;
  [key: string]: unknown;
}

export function ledgerPath(): string {
  return process.env.LEDGER_PATH ?? join(SUPERVISOR_DIR, "ledger.jsonl");
}

export function appendLedgerLine(entry: LedgerLine, file = ledgerPath()): void {
  appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function appendEvent(type: string, refs: Record<string, unknown>, note?: string, file = ledgerPath()): void {
  appendLedgerLine({
    ts: new Date().toISOString(),
    actor: "shift-supervisor",
    type,
    refs,
    ...(note ? { note } : {}),
  }, file);
}

export function readLedger(file = ledgerPath()): { entries: LedgerLine[]; invalidLines: number } {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return { entries: [], invalidLines: 0 }; }
  const entries: LedgerLine[] = [];
  let invalidLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as LedgerLine); }
    catch { invalidLines += 1; }
  }
  return { entries, invalidLines };
}

export function entriesSinceLastReport(entries: LedgerLine[]): LedgerLine[] {
  let last = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.type === "report_posted") last = i;
  }
  return entries.slice(last + 1);
}

export function taskIdOf(entry: LedgerLine): string | null {
  if (typeof entry.taskId === "string") return entry.taskId;
  return typeof entry.refs?.task === "string" ? entry.refs.task : null;
}
