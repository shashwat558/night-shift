import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedgerLine, entriesSinceLastReport, readLedger } from "../src/ledger.js";
import { createReportArtifact, publishShiftReport, renderShiftReport } from "../src/report.js";

const fixtures = join(import.meta.dirname, "..", "..", "test", "fixtures");

test("fixture ledger renders the golden report exactly", () => {
  const { entries, invalidLines } = readLedger(join(fixtures, "report-ledger.jsonl"));
  const got = renderShiftReport(entries, "2026-11-06", invalidLines);
  const want = readFileSync(join(fixtures, "report-golden.md"), "utf8");
  assert.equal(got, want);
});

test("ledger append preserves every existing byte and report windows follow report_posted", () => {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-ledger-"));
  const file = join(dir, "ledger.jsonl");
  const prefix = '{"ts":"a","taskId":"A","branch":"shift/A"}\n';
  writeFileSync(file, prefix);
  appendLedgerLine({ ts: "b", actor: "shift-supervisor", type: "report_posted", refs: { file: "docs/reports/x.md" } }, file);
  appendLedgerLine({ ts: "c", actor: "shift-supervisor", type: "block", refs: { task: "C" } }, file);
  assert.equal(readFileSync(file, "utf8").slice(0, prefix.length), prefix);
  assert.deepEqual(entriesSinceLastReport(readLedger(file).entries).map(e => e.type), ["block"]);
});

test("publish is idempotent when no events follow today's report", async () => {
  const repo = mkdtempSync(join(tmpdir(), "nightshift-report-"));
  const ledger = join(repo, "ledger.jsonl");
  writeFileSync(ledger, readFileSync(join(fixtures, "report-ledger.jsonl")));
  let posts = 0;
  const first = await publishShiftReport(repo, "cli", async () => { posts += 1; return true; }, new Date(2026, 10, 6, 9), ledger);
  const second = await publishShiftReport(repo, "room", async () => { posts += 1; return true; }, new Date(2026, 10, 6, 10), ledger);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(posts, 1);
  assert.equal(second.content, first.content);
});
