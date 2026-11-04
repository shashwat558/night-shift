// scripts/p2-checks.mjs — offline verification for phase 2 (called by verify.sh).
//
// Checks (no AI calls, no network beyond localhost):
//   1. Synthetic goal → 1 slips file: parseSlips accepts a valid slip
//      and rejects a broken one with the right error.
//   2. Synthetic receipt → PR body render: renderReceipts + renderPrBody emit
//      the §4.2 field order; parseProviderReceipt round-trips.
//   3. Parser/renderer/ws unit tests all pass (node --test dist/test/*.test.js).
//   4. main.ts exported helpers compile (import the dist module; no crash).
//   5. ledger.jsonl schema: appendLedger writes valid JSON lines.
//
// Exits 0 when every check passes. Non-zero on the first failure.
// Prints one PASS/FAIL line per check.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const DIST = join(ROOT, "supervisor", "dist");

let ok = true;
const pass = (m) => console.log(`PASS ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); ok = false; };

// ── 1. slips parser (parseSlips) ─────────────────────────────────────────────
{
  let mod;
  try {
    mod = await import(`file://${join(DIST, "src", "slips.js")}`);
  } catch (e) {
    fail(`import slips.js: ${e.message}`);
    process.exit(1);
  }
  const { parseSlips } = mod;

  const VALID_SLIP = `\
slips:
  - id: B-20261103-01
    backlog_ref: BACKLOG-1
    title: Add input validation to POST /pets
    assignee: shift-worker-1
    scope: >-
      Validate POST /pets body: name required non-empty string.
    files_allowed:
      - src/routes/pets.js
    acceptance:
      - POST /pets with empty name returns 400
    time_budget_minutes: 20
`;
  const r1 = parseSlips(VALID_SLIP);
  if (r1.ok && r1.slips.length === 1 && r1.slips[0].id === "B-20261103-01") {
    pass("parseSlips: valid slip round-trips");
  } else {
    fail(`parseSlips: valid slip failed — ${r1.ok ? "wrong output" : (r1.errors ?? []).join("; ")}`);
  }

  const BAD_SLIP = `slips:\n  - notid: oops\n    title: broken\n`;
  const r2 = parseSlips(BAD_SLIP);
  if (!r2.ok && r2.errors && r2.errors.length > 0) {
    pass("parseSlips: invalid slip rejected with errors");
  } else {
    fail(`parseSlips: invalid slip was not rejected (ok=${r2.ok})`);
  }

  // missing required field (no backlog_ref)
  const MISSING_FIELD = `slips:\n  - id: B-20261103-01\n    title: missing backlog\n    assignee: shift-worker-1\n    scope: scope\n    files_allowed:\n      - src/a.js\n    acceptance:\n      - a passes\n    time_budget_minutes: 10\n`;
  const r3 = parseSlips(MISSING_FIELD);
  if (!r3.ok) {
    pass("parseSlips: slip missing backlog_ref rejected");
  } else {
    fail("parseSlips: slip missing backlog_ref was accepted (should be rejected)");
  }
}

// ── 2. receipts renderer + parser (renderReceipts, renderPrBody, parseProviderReceipt) ─
{
  let mod;
  try {
    mod = await import(`file://${join(DIST, "src", "prs.js")}`);
  } catch (e) {
    fail(`import prs.js: ${e.message}`);
    process.exit(1);
  }
  const { renderReceipts, renderPrBody, parseProviderReceipt } = mod;

  const slip = {
    id: "B-20261103-01",
    backlog_ref: "BACKLOG-1",
    title: "Add input validation",
    assignee: "shift-worker-1",
    scope: "validate POST /pets",
    files_allowed: ["src/routes/pets.js"],
    acceptance: ["POST /pets with empty name returns 400"],
    time_budget_minutes: 20,
  };
  const wip = {
    filesTouched: ["src/routes/pets.js"],
    testPass: true,
    testOutput: "npm test\n1..3\nok 1 name\nok 2 species\nok 3 existing\n",
    startedAt: 1_000,
    finishedAt: 1_000 + 61_000,
    timedOut: false,
    providerOutput: "",
  };

  const block = renderReceipts(slip, wip, { found: false });
  const REQUIRED_FIELDS = ["summary", "files-touched", "tests", "test-log", "risk-call", "deviations", "budget"];
  const present = REQUIRED_FIELDS.filter((f) => block.includes(`- ${f}:`));
  if (present.length === REQUIRED_FIELDS.length) {
    pass("renderReceipts: all §4.2 fields present");
  } else {
    fail(`renderReceipts: missing fields: ${REQUIRED_FIELDS.filter((f) => !block.includes(`- ${f}:`)).join(", ")}`);
  }

  // field order: summary first, budget last
  const lines = block.split("\n").filter((l) => /^\s*-\s*[\w-]+:/.test(l));
  const fieldOrder = lines.map((l) => (/^\s*-\s*([\w-]+):/.exec(l) ?? [])[1]);
  const sumIdx = fieldOrder.indexOf("summary");
  const budIdx = fieldOrder.indexOf("budget");
  if (sumIdx === 0 && budIdx === fieldOrder.length - 1) {
    pass("renderReceipts: summary first, budget last");
  } else {
    fail(`renderReceipts: wrong field order — summary@${sumIdx}, budget@${budIdx} of ${fieldOrder.length}`);
  }

  // PASS/FAIL marker
  if (block.includes("- tests: PASS")) {
    pass("renderReceipts: PASS marker present for passing run");
  } else {
    fail("renderReceipts: PASS marker missing");
  }

  // renderPrBody: receipts block is last non-empty part
  const body = renderPrBody(slip, block, { ghRepo: "acme/petshop", provider: "opencode" });
  const bodyLines = body.split("\n").filter(Boolean);
  const lastLine = bodyLines[bodyLines.length - 1] ?? "";
  if (lastLine.startsWith("- budget:")) {
    pass("renderPrBody: receipts block is last (budget line is final)");
  } else {
    fail(`renderPrBody: last non-empty line is not budget (got: "${lastLine}")`);
  }

  // parseProviderReceipt round-trip
  const synthetic = [
    "working...",
    "```",
    `#### receipts — ${slip.id}`,
    "- summary: wired the validation",
    "- files-touched: src/routes/pets.js",
    "- tests: PASS",
    "- test-log: test tail below",
    "- risk-call: low — isolated to one route",
    "- deviations: none",
    "- budget: 17 / 20 min",
    "```",
  ].join("\n");
  const rt = parseProviderReceipt(synthetic, slip.id);
  if (rt.found && rt.summary === "wired the validation" && rt.riskCall === "low — isolated to one route") {
    pass("parseProviderReceipt: round-trip fields correct");
  } else {
    fail(`parseProviderReceipt: round-trip failed — found=${rt.found} summary="${rt.summary}" risk="${rt.riskCall}"`);
  }

  // not-found case
  const notFound = parseProviderReceipt("plain output with no receipts block", slip.id);
  if (!notFound.found) {
    pass("parseProviderReceipt: missing block → found=false");
  } else {
    fail("parseProviderReceipt: missing block returned found=true");
  }
}

// ── 3. main.ts helpers (import dist/src/main.js, check exported symbols) ──────
{
  let mod;
  try {
    mod = await import(`file://${join(DIST, "src", "main.js")}`);
  } catch (e) {
    fail(`import main.js: ${e.message}`);
    process.exit(1);
  }
  const { assignmentNarration, runSummaryPost, appendLedger } = mod;

  // assignmentNarration mentions the slip id and handle
  const slip = {
    id: "B-20261103-01",
    title: "Add validation",
    assignee: "shift-worker-1",
    scope: "scope text",
    time_budget_minutes: 20,
    backlog_ref: "BACKLOG-1",
    files_allowed: [],
    acceptance: [],
  };
  const narr = assignmentNarration(slip, "nightshift-worker-1");
  if (narr.includes(slip.id) && narr.includes("nightshift-worker-1")) {
    pass("assignmentNarration: contains task id and worker handle");
  } else {
    fail(`assignmentNarration: missing task id or handle — "${narr.slice(0, 80)}"`);
  }

  // runSummaryPost: PASS case
  const passPost = runSummaryPost(slip, "https://github.com/x/y/pull/7", 7, true, false, undefined, "added validation");
  if (passPost.includes("PASS") && passPost.includes("#7") && passPost.includes(slip.id)) {
    pass("runSummaryPost: PASS, PR#, task id present");
  } else {
    fail(`runSummaryPost: PASS case missing fields — "${passPost.slice(0, 120)}"`);
  }

  // runSummaryPost: BLOCKED case
  const blockedPost = runSummaryPost(slip, null, null, null, true, "worktree dirty", slip.title);
  if (blockedPost.includes("BLOCKED") && blockedPost.includes("worktree dirty")) {
    pass("runSummaryPost: BLOCKED reason propagated");
  } else {
    fail(`runSummaryPost: BLOCKED case wrong — "${blockedPost.slice(0, 120)}"`);
  }

  // appendLedger: writes valid JSON to a temp file
  const tmpDir = mkdtempSync(join(tmpdir(), "nightshift-p2-"));
  const tmpLedger = join(tmpDir, "ledger.jsonl");
  const origPath = process.env.LEDGER_PATH;
  process.env.LEDGER_PATH = tmpLedger;
  const entry = {
    ts: new Date().toISOString(),
    taskId: slip.id,
    branch: `shift/${slip.id}`,
    prUrl: "https://github.com/x/y/pull/7",
    prNumber: 7,
    testPass: true,
    blocked: false,
    summary: "added validation",
    filesChanged: 1,
    budgetMin: 20,
    spentMin: 15,
  };
  appendLedger(entry);
  if (origPath === undefined) delete process.env.LEDGER_PATH;
  else process.env.LEDGER_PATH = origPath;

  const written = readFileSync(tmpLedger, "utf8").trim();
  let parsed;
  try {
    parsed = JSON.parse(written);
  } catch (e) {
    fail(`appendLedger: written line is not valid JSON — ${e.message}`);
    parsed = null;
  }
  if (parsed && parsed.taskId === slip.id && parsed.testPass === true) {
    pass("appendLedger: writes valid JSONL with correct fields");
  } else if (parsed) {
    fail(`appendLedger: wrong fields in JSONL — ${JSON.stringify(parsed).slice(0, 100)}`);
  }
  // cleanup
  try { unlinkSync(tmpLedger); } catch {}
}

// ── 4. unit test suite (node --test dist/test/*.test.js) ─────────────────────
{
  const testDir = join(DIST, "test");
  if (!existsSync(testDir)) {
    fail("dist/test/ does not exist — run: cd supervisor && npm run build");
    process.exit(1);
  }

  // Run all test files via node --test
  const result = spawnSync(
    process.execPath,
    ["--test", "dist/test/slips.test.js", "dist/test/prs.test.js", "dist/test/goals.test.js",
     "dist/test/spawner.test.js", "dist/test/switchclient.test.js", "dist/test/ws.test.js"],
    { cwd: join(ROOT, "supervisor"), stdio: "pipe", encoding: "utf8", timeout: 120_000 }
  );

  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.status === 0) {
    // count PASS lines
    const passCount = (combined.match(/^# tests (\d+)/m) ?? [])[1] ?? "?";
    const failCount = (combined.match(/^# fail (\d+)/m) ?? [])[1] ?? "0";
    pass(`unit tests: ${passCount} tests, ${failCount} failures`);
  } else {
    // surface the failures
    const failLines = combined.split("\n").filter((l) => l.startsWith("not ok") || l.includes("FAIL")).slice(0, 10);
    fail(`unit tests exited ${result.status ?? "?"}: ${failLines.join(" | ").slice(0, 300)}`);
    if (combined.length > 0) {
      console.error(combined.slice(-2000));
    }
  }
}

// ── exit ─────────────────────────────────────────────────────────────────────
if (ok) {
  console.log(`ALL ${new Date().toISOString()}: p2-checks passed (offline)`);
  process.exit(0);
} else {
  console.error(`ALL ${new Date().toISOString()}: p2-checks FAILED`);
  process.exit(1);
}
