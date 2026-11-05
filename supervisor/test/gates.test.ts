// supervisor/test/gates.test.ts — the P3 gate table, offline:
//   - gate command grammar (§4.4)
//   - receipts-block validation against crew/receipt.schema.md (exact gaps)
//   - decision matrix (approve WITHOUT CI green rejected; FAIL never merges;
//     missing field ⇒ needs-eyes; rollback; hold)
//   - gh plumbing through a fake gh on a PATH shim dir (no GitHub)
//   - ledger rebuild for the open-task registry
// The receipts blocks under test are produced by the REAL renderers (prs.ts)
// so validation is provably compatible with what the supervisor opens.

import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGateCommand,
  parseReceiptBlock,
  validateReceiptBlock,
  decideGate,
  handleGateCommand,
  rebuildOpenTasks,
  appendGateEvent,
  needsEyesPost,
  type ReceiptCheck,
} from "../src/gates.js";
import { renderPrBody, renderReceipts, type RunFacts, type ProviderReceiptAttempt } from "../src/prs.js";
import { testConfig } from "../src/env.js";
import type { Slip } from "../src/slips.js";

let base: string;
let shimDir: string;
let tmpLedger: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "nightshift-gates-"));
  shimDir = join(base, "shim");
  tmpLedger = join(base, "ledger.jsonl");
});

const SHIM_SHEBANG = "#!/usr/bin/env bash";

function slipFixture(overrides?: Partial<Slip>): Slip {
  return {
    id: "B-20261105-01",
    backlog_ref: "BACKLOG-1",
    title: "Add input validation to POST /pets",
    assignee: "shift-worker-1",
    scope: "Validate POST /pets body: name required non-empty string.",
    files_allowed: ["src/routes/pets.js"],
    acceptance: ["POST /pets with empty name returns 400"],
    time_budget_minutes: 20,
    notes: "",
    ...overrides,
  };
}

function runFacts(overrides?: Partial<RunFacts>): RunFacts {
  return {
    filesTouched: ["src/routes/pets.js"],
    testPass: true,
    testOutput: "node --test 1..3\nok 1 name required\nPETSHOP-TESTS-GREEN\n",
    startedAt: 1_000,
    finishedAt: 1_000 + 11 * 60_000, // 11 measured minutes
    timedOut: false,
    providerOutput: "#### receipts — B-20261105-01\n- summary: wired validation\n- risk-call: low — route isolated\n- deviations: none\n",
    ...overrides,
  };
}

function providerAttempt(): ProviderReceiptAttempt {
  return { found: true, summary: "wired validation", riskCall: "low — route isolated", deviations: "none" };
}

/** A full PR body exactly as createDraftPr would open it. */
function prBodyFor(slip: Slip, facts: RunFacts = runFacts(), attempt = providerAttempt()): string {
  return renderPrBody(slip, renderReceipts(slip, facts, attempt), { ghRepo: "acme/petshop", provider: "opencode" });
}

const receiptContract = (slip: Slip) => ({
  taskId: slip.id,
  filesAllowed: slip.files_allowed,
  budgetMinutes: slip.time_budget_minutes,
});

// ---- 1. gate command grammar -------------------------------------------------

test("parseGateCommand: @-mention prefix, all three verbs", () => {
  assert.deepEqual(parseGateCommand("@shift-supervisor approve B-20261105-01"), {
    verb: "approve",
    taskId: "B-20261105-01",
    reason: null,
  });
  assert.deepEqual(parseGateCommand("rollback B-20261105-02"), {
    verb: "rollback",
    taskId: "B-20261105-02",
    reason: null,
  });
  assert.deepEqual(parseGateCommand("@shift-supervisor hold B-20261105-03"), {
    verb: "hold",
    taskId: "B-20261105-03",
    reason: null,
  });
});

test("parseGateCommand: free-text reason rides along (the 'rolled back: <reason>' slot)", () => {
  const g = parseGateCommand("@shift-supervisor rollback B-20261105-02 worker touched auth file");
  assert.equal(g?.verb, "rollback");
  assert.equal(g?.taskId, "B-20261105-02");
  assert.equal(g?.reason, "worker touched auth file");
});

test("parseGateCommand: multi-mention then verb; multiple spaces tolerated", () => {
  let g = parseGateCommand("@shashwat558/nightshift @supervisor hold   B-20261105-99");
  assert.equal(g?.verb, "hold");
  g = parseGateCommand("@shift-supervisor\napprove B-20261105-01");
  assert.equal(g?.verb, "approve");
  assert.equal(g?.taskId, "B-20261105-01");
});

test("parseGateCommand: everything else is noise, not a gate", () => {
  assert.equal(parseGateCommand(""), null);
  assert.equal(parseGateCommand("tonight: implement BACKLOG 1-3"), null);
  assert.equal(parseGateCommand("@shift-supervisor please merge B-20261105-01"), null);
  assert.equal(parseGateCommand("take B-20261105-01"), null); // worker ack grammar
  assert.equal(parseGateCommand("approve"), null);
  // an id that parses but no task exists for → runtime answers with the
  // honest "no open task" post (handleGateCommand's unknown-task path)
  assert.equal(parseGateCommand("approve somebody")?.taskId, "somebody");
});

// ---- 2. receipts-block validation --------------------------------------------

test("parseReceiptBlock finds fields and the fenced test-log tail", () => {
  const body = prBodyFor(slipFixture());
  const block = parseReceiptBlock(body, "B-20261105-01");
  assert.equal(block.found, true);
  assert.equal(block.fields["summary"], "wired validation");
  assert.match(block.fields["tests"] ?? "", /^PASS$/);
  assert.equal(block.fields["risk-call"], "low — route isolated");
  assert.equal(block.fields["deviations"], "none");
  assert.equal(block.fields["budget"], "11 / 20 min");
  assert.ok(block.testLogBody.includes("PETSHOP-TESTS-GREEN"), block.testLogBody);
});

test("validateReceiptBlock: the real-renderer body validates clean", () => {
  const slip = slipFixture();
  const check = validateReceiptBlock(prBodyFor(slip), receiptContract(slip));
  assert.deepEqual(check.gaps, []);
  assert.equal(check.ok, true);
  assert.equal(check.testPass, true);
  assert.equal(check.riskLevel, "low");
  assert.equal(check.budgetSpent, 11);
  assert.equal(check.budgetCap, 20);
});

test("validateReceiptBlock: a missing field names itself exactly (needs-eyes)", () => {
  const slip = slipFixture();
  let body = prBodyFor(slip).replace(/- summary: .*\n/, "");
  const check = validateReceiptBlock(body, receiptContract(slip));
  assert.equal(check.ok, false);
  assert.ok(check.gaps.includes("missing field: summary"), check.gaps.join("; "));

  body = prBodyFor(slip).replace(/- risk-call: .*\n/, "");
  const c2 = validateReceiptBlock(body, receiptContract(slip));
  assert.ok(c2.gaps.includes("missing field: risk-call"), c2.gaps.join("; "));

  body = prBodyFor(slip).replace(/- budget: .*\n/, "");
  const c3 = validateReceiptBlock(body, receiptContract(slip));
  assert.ok(c3.gaps.includes("missing field: budget"), c3.gaps.join("; "));
});

test("validateReceiptBlock: empty test-log fence catches the paraphrase crime", () => {
  const slip = slipFixture();
  const body = prBodyFor(slip, runFacts({ testOutput: "" }));
  const check = validateReceiptBlock(body, receiptContract(slip));
  assert.equal(check.ok, false);
  assert.ok(
    check.gaps.includes("test-log fenced block is empty — the RAW runner tail must be inside it"),
    check.gaps.join("; "),
  );
});

test("validateReceiptBlock: no block at all ⇒ one explicit gap", () => {
  const slip = slipFixture();
  const check = validateReceiptBlock("we shipped something. trust me.", receiptContract(slip));
  assert.equal(check.ok, false);
  assert.deepEqual(check.gaps, [`receipts block for ${slip.id} not found in the PR body`]);
});

test("validateReceiptBlock: tests must be literally PASS or FAIL", () => {
  const slip = slipFixture();
  let body = prBodyFor(slip).replace("- tests: PASS", "- tests: passing all green");
  const check = validateReceiptBlock(body, receiptContract(slip));
  assert.match(check.gaps.join(" "), /tests must be literally PASS or FAIL/);
  assert.equal(check.testPass, null);
});

test("validateReceiptBlock: FAIL tests are a valid receipt the gate refuses", () => {
  const slip = slipFixture();
  const body = prBodyFor(slip, runFacts({ testPass: false }));
  const check = validateReceiptBlock(body, receiptContract(slip));
  assert.equal(check.ok, true);
  assert.equal(check.testPass, false);
});

test("validateReceiptBlock: risk-call must be an enum plus a reason", () => {
  const slip = slipFixture();
  const body = prBodyFor(slip, runFacts(), {
    found: true,
    riskCall: "unfiled — headless run produced no risk statement",
  });
  const check = validateReceiptBlock(body, receiptContract(slip));
  assert.equal(check.ok, false);
  assert.match(check.gaps.join(" "), /risk-call must start with low\|medium\|high/);
});

test("validateReceiptBlock: budget shape + overspend", () => {
  const slip = slipFixture();
  const shape = prBodyFor(slip).replace("- budget: 11 / 20 min", "- budget: about 15 minutes");
  let check = validateReceiptBlock(shape, receiptContract(slip));
  assert.match(check.gaps.join(" "), /budget must be "<spent> \/ <budget> min"/);

  const overspent = prBodyFor(slip).replace("- budget: 11 / 20 min", "- budget: 25 / 20 min");
  check = validateReceiptBlock(overspent, receiptContract(slip));
  assert.match(check.gaps.join(" "), /budget exceeded: spent 25 > 20 min/);
});

test("validateReceiptBlock: scope deviation is named with the exact forbidden paths", () => {
  const slip = slipFixture();
  const body = prBodyFor(slip, runFacts({ filesTouched: ["src/routes/pets.js", "src/auth.js"] }), {
    found: true,
    summary: "wired validation (also rewrote auth)",
  });
  const check = validateReceiptBlock(body, receiptContract(slip));
  assert.equal(check.ok, false);
  assert.match(check.gaps.join(" "), /outside the slip's files_allowed: src\/auth\.js/);
});

test("validateReceiptBlock: field order out of schema order is a gap", () => {
  const slip = slipFixture();
  const head = prBodyFor(slip);
  // reorder: pull the summary line out and re-insert it after the budget line
  const reordered = (function build(): string {
    const lines = head.split("\n");
    const sumIdx = lines.findIndex((l) => l.startsWith("- summary:"));
    const budIdx = lines.findIndex((l) => l.startsWith("- budget:"));
    if (sumIdx === -1 || budIdx === -1) throw new Error("fixture lacks summary/budget lines");
    const [sum] = lines.splice(sumIdx, 1);
    if (sum === undefined) throw new Error("no summary line");
    lines.splice(budIdx, 0, sum);
    return lines.join("\n");
  })();
  void reordered;
  const check = validateReceiptBlock(reordered, receiptContract(slip));
  assert.equal(check.ok, false);
  assert.match(check.gaps.join(" "), /field order wrong/);
});

test("needsEyesPost pastes the gaps verbatim", () => {
  const post = needsEyesPost("B-20261105-01", ["missing field: summary", "missing field: risk-call"]);
  assert.ok(post.includes("👀 needs-eyes"), post);
  assert.ok(post.includes("missing field: summary"));
  assert.ok(post.includes("missing field: risk-call"));
  assert.ok(post.includes("B-20261105-01"));
});

// ---- 3. the decision matrix ---------------------------------------------------

function checkFixture(overrides?: Partial<ReceiptCheck>): ReceiptCheck {
  const ok: ReceiptCheck = {
    ok: true,
    gaps: [],
    testPass: true,
    riskLevel: "low",
    declaredDeviations: false,
    filesTouched: [],
    budgetSpent: 11,
    budgetCap: 20,
  };
  return { ...ok, ...overrides };
}

const green = { ciState: "green" as const, ciDetail: "1 checks" };
const pending = { ciState: "pending" as const, ciDetail: "1 checks, still running" };

test("DECISION MATRIX: approve with clean receipt + CI green ⇒ merge", () => {
  const d = decideGate({ verb: "approve", taskId: "T-1", ...green, receipt: checkFixture(), hasOpenPr: true });
  assert.equal(d.action, "merge");
});

test("DECISION MATRIX: approve WITHOUT CI green is rejected, with the current state said", () => {
  const pendingD = decideGate({ verb: "approve", taskId: "T-1", ...pending, receipt: checkFixture(), hasOpenPr: true });
  assert.equal(pendingD.action, "refuse_ci");
  assert.match(pendingD.reply, /CI state: \*\*pending\*\*/);
  assert.match(pendingD.reply, /approve counts only with CI green/);

  const redD = decideGate({ verb: "approve", taskId: "T-1", ciState: "red", ciDetail: "1 checks, failures present", receipt: checkFixture(), hasOpenPr: true });
  assert.equal(redD.action, "refuse_ci");
  assert.match(redD.reply, /CI state: \*\*red\*\*/);

  const noneD = decideGate({ verb: "approve", taskId: "T-1", ciState: "none", ciDetail: "no checks recorded", receipt: checkFixture(), hasOpenPr: true });
  assert.equal(noneD.action, "refuse_ci");
});

test("DECISION MATRIX: approve with receipt gaps ⇒ needs-eyes naming the exact gaps", () => {
  const receipt = checkFixture({ ok: false, gaps: ["missing field: summary", "missing field: risk-call"] });
  const d = decideGate({ verb: "approve", taskId: "T-1", ...green, receipt, hasOpenPr: true });
  assert.equal(d.action, "refuse_receipt");
  assert.match(d.reply, /missing field: summary/);
  assert.match(d.reply, /missing field: risk-call/);
  assert.match(d.reply, /needs-eyes/);
});

test("DECISION MATRIX: a receipt that says FAIL can never merge", () => {
  const receipt = checkFixture({ testPass: false });
  const d = decideGate({ verb: "approve", taskId: "T-1", ...green, receipt, hasOpenPr: true });
  assert.equal(d.action, "refuse_receipt");
  assert.match(d.reply, /FAIL/);
  assert.match(d.reply, /never merge/);
});

test("DECISION MATRIX: hold keeps the PR draft (needs-eyes state, recorded)", () => {
  const d = decideGate({ verb: "hold", taskId: "T-1", ...green, receipt: checkFixture(), hasOpenPr: true });
  assert.equal(d.action, "hold");
  assert.match(d.reply, /held/);
  assert.match(d.reply, /stays draft/);
});

test("DECISION MATRIX: rollback always honored on an open PR", () => {
  const d = decideGate({ verb: "rollback", taskId: "T-1", ...pending, receipt: checkFixture({ ok: false, gaps: ["whatever"] }), hasOpenPr: true });
  assert.equal(d.action, "rollback");
});

test("DECISION MATRIX: gates refuse to act on unreadable PRs", () => {
  for (const verb of ["approve", "rollback", "hold"] as const) {
    const d = decideGate({ verb, taskId: "T-1", ...green, receipt: checkFixture(), hasOpenPr: false });
    assert.equal(d.action, "unknown_pr", `verb=${d.action}`);
    assert.match(d.reply, /refused/);
  }
});

// ---- 4. gh plumbing + full handleGateCommand flow -----------------------------

function writeGhShim(opts: { viewJson: string; readyOk?: boolean; mergeOk?: boolean; closeOk?: boolean }): void {
  mkdirSync(shimDir, { recursive: true });
  const script = [
    SHIM_SHEBANG,
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    '  echo "$NSP_GH_VIEW_JSON"',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then',
    `  [ "$NSP_GH_READY_OK" = "1" ] || { echo "ready denied" >&2; exit 1; }`,
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then',
    '  echo "Merged pull request #7"',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "close" ]; then',
    `  [ "$NSP_GH_CLOSE_OK" = "1" ] || { echo "close denied" >&2; exit 1; }`,
    '  echo "Closed pull request #7"',
    "  exit 0",
    "fi",
    'if [ "$1" = "push" ] && [ "$2" = "origin" ]; then',
    "  exit 0",
    "fi",
    "echo unexpected gh call: $* >&2",
    "exit 3",
  ].join("\n");
  writeFileSync(join(shimDir, "gh"), script + "\n");
  chmodSync(join(shimDir, "gh"), 0o750);
  // git shim: push --delete is stubbed inside gh shim path order
  const gitScript = [SHIM_SHEBANG, 'if [ "$1" = "push" ]; then', "  exit 0", "fi", 'exec /usr/bin/git "$@"'].join("\n");
  writeFileSync(join(shimDir, "git"), gitScript + "\n");
  chmodSync(join(shimDir, "git"), 0o750);
}

function shimEnv(opts: { viewJson?: string; readyOk?: boolean; closeOk?: boolean }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    NSP_GH_VIEW_JSON: opts.viewJson ?? "",
    NSP_GH_READY_OK: opts.readyOk === false ? "0" : "1",
    NSP_GH_CLOSE_OK: opts.closeOk === false ? "0" : "1",
  };
}

const GREEN_VIEW = JSON.stringify({
  state: "OPEN",
  isDraft: true,
  body: prBodyFor(slipFixture()),
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  mergeCommit: null,
});

const PENDING_VIEW = JSON.stringify({
  state: "OPEN",
  isDraft: true,
  body: prBodyFor(slipFixture()),
  statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
  mergeCommit: null,
});

interface Post {
  room: string;
  content: string;
}

function fakeClient(posts: Post[]): { postMessage: (r: string, c: string) => Promise<boolean> } {
  return {
    postMessage: async (room, content) => {
      posts.push({ room, content });
      return true;
    },
  };
}

interface Guard {
  origLedger: string | undefined;
}

function withTestLedger(): Guard {
  const origLedger = process.env.LEDGER_PATH;
  process.env.LEDGER_PATH = tmpLedger;
  return { origLedger };
}
function restoreLedger(g: Guard): void {
  if (g.origLedger === undefined) delete process.env.LEDGER_PATH;
  else process.env.LEDGER_PATH = g.origLedger;
}

test("handleGateCommand: approve → ready+merge, ✅ post, registry drop, gate_result+merge ledger lines", async () => {
  writeGhShim({ viewJson: GREEN_VIEW });
  const posts: Post[] = [];
  const registry = new Map([
    ["B-20261105-01", { taskId: "B-20261105-01", branch: "shift/B-20261105-01", prNumber: 7, prUrl: "https://github.com/acme/petshop/pull/7" }],
  ]);
  const guard = withTestLedger();
  try {
    const decision = await handleGateCommand(
      { cfg: testConfig(), client: fakeClient(posts), roomId: "room-1", registry, by: "human:shashwat" },
      parseGateCommand("@shift-supervisor approve B-20261105-01") as NonNullable<ReturnType<typeof parseGateCommand>>,
      { envOverride: shimEnv({ viewJson: GREEN_VIEW }), log: () => {} },
    );
    assert.equal(decision.action, "merge");
    // Report the completed action once, after it succeeds.
    assert.equal(posts.length, 1);
    const merged = posts.map((p) => p.content).find((c) => c.includes("✅"));
    assert.ok(merged, `no merged post: ${JSON.stringify(posts)}`);
    assert.match(merged ?? "", /PR #7/);
    assert.match(merged ?? "", /CI green/);
    assert.equal(registry.has("B-20261105-01"), false, "merged task must leave the registry");

    // ledger: gate_result approved + merge event (SPEC §4.3 shapes)
    const text = readFileSync(tmpLedger, "utf8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const gateLine = lines.find((l) => l.type === "gate_result");
    assert.ok(gateLine, "gate_result event missing");
    assert.equal(gateLine.actor, "shift-supervisor");
    assert.equal((gateLine.refs as Record<string, unknown>).gate, "approved");
    assert.equal((gateLine.refs as Record<string, unknown>).ci, "green");
    const mergeLine = lines.find((l) => l.type === "merge");
    assert.ok(mergeLine, "merge event missing");
    assert.equal((mergeLine.refs as Record<string, unknown>).pr, 7);
  } finally {
    restoreLedger(guard);
  }
});

test("handleGateCommand: approve WITHOUT CI green ⇒ refusal post with the CI state, registry untouched", async () => {
  writeGhShim({ viewJson: PENDING_VIEW });
  const posts: Post[] = [];
  const registry = new Map([
    ["B-20261105-01", { taskId: "B-20261105-01", branch: "shift/B-20261105-01", prNumber: 7, prUrl: null }],
  ]);
  const guard = withTestLedger();
  try {
    const decision = await handleGateCommand(
      { cfg: testConfig(), client: fakeClient(posts), roomId: "room-1", registry },
      parseGateCommand("approve B-20261105-01") as NonNullable<ReturnType<typeof parseGateCommand>>,
      { envOverride: shimEnv({ viewJson: PENDING_VIEW }), log: () => {} },
    );
    assert.equal(decision.action, "refuse_ci");
    const refused = posts.map((p) => p.content).find((c) => c.includes("refused"));
    assert.match(refused ?? "", /CI state: \*\*pending\*\*/);
    assert.equal(registry.has("B-20261105-01"), true, "refused gate must NOT close the task");
    const text = readFileSync(tmpLedger, "utf8");
    assert.match(text, /approve_refused_ci/);
  } finally {
    restoreLedger(guard);
  }
});

test("handleGateCommand: rollback ⇒ close + branch delete + 'rolled back: <reason>' post", async () => {
  writeGhShim({ viewJson: GREEN_VIEW });
  const posts: Post[] = [];
  const registry = new Map([
    ["B-20261105-01", { taskId: "B-20261105-01", branch: "shift/B-20261105-01", prNumber: 7, prUrl: null }],
  ]);
  const guard = withTestLedger();
  try {
    const decision = await handleGateCommand(
      { cfg: testConfig(), client: fakeClient(posts), roomId: "room-1", registry },
      parseGateCommand("rollback B-20261105-01 worker touched auth file") as NonNullable<ReturnType<typeof parseGateCommand>>,
      { envOverride: shimEnv({ viewJson: GREEN_VIEW }), log: () => {} },
    );
    assert.equal(decision.action, "rollback");
    assert.equal(posts.length, 1);
    assert.match(decision.reply, /rolled back: worker touched auth file/);
    const rolled = posts.map((p) => p.content).find((c) => c.includes("rolled back"));
    assert.match(rolled ?? "", /rolled back: worker touched auth file/);
    assert.match(rolled ?? "", /PR #7 closed/);
    assert.equal(registry.has("B-20261105-01"), false, "rolled-back task must leave the registry");
    assert.match(readFileSync(tmpLedger, "utf8"), /rolled_back/);
  } finally {
    restoreLedger(guard);
  }
});

test("handleGateCommand: missing receipt field ⇒ needs-eyes post naming the exact gap, PR stays", async () => {
  const gappedView = JSON.stringify({
    state: "OPEN",
    isDraft: true,
    body: prBodyFor(slipFixture()).replace(/- summary: .*\n/, ""),
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    mergeCommit: null,
  });
  writeGhShim({ viewJson: gappedView });
  const posts: Post[] = [];
  const registry = new Map([
    ["B-20261105-01", { taskId: "B-20261105-01", branch: "shift/B-20261105-01", prNumber: 7, prUrl: null }],
  ]);
  const guard = withTestLedger();
  try {
    const decision = await handleGateCommand(
      { cfg: testConfig(), client: fakeClient(posts), roomId: "room-1", registry },
      parseGateCommand("approve B-20261105-01") as NonNullable<ReturnType<typeof parseGateCommand>>,
      { envOverride: shimEnv({ viewJson: gappedView }), log: () => {} },
    );
    assert.equal(decision.action, "refuse_receipt");
    const eyes = posts.map((p) => p.content).find((c) => c.includes("needs-eyes"));
    assert.match(eyes ?? "", /missing field: summary/);
    assert.equal(registry.has("B-20261105-01"), true, "needs-eyes keeps the PR");
    assert.match(readFileSync(tmpLedger, "utf8"), /needs_eyes/);
  } finally {
    restoreLedger(guard);
  }
});

test("handleGateCommand: unknown task gets an honest ❓ post and no ledger event", async () => {
  writeGhShim({ viewJson: GREEN_VIEW });
  const posts: Post[] = [];
  const registry = new Map();
  const guard = withTestLedger();
  try {
    const decision = await handleGateCommand(
      { cfg: testConfig(), client: fakeClient(posts), roomId: "room-1", registry },
      parseGateCommand("approve B-19990101-99") as NonNullable<ReturnType<typeof parseGateCommand>>,
      { envOverride: shimEnv({ viewJson: GREEN_VIEW }), log: () => {} },
    );
    assert.equal(decision.action, "unknown_task");
    assert.match(posts[0]?.content ?? "", /no open task .*B-19990101-99/);
    assert.ok(!existsSync(tmpLedger), "unknown task must not write any ledger event");
  } finally {
    restoreLedger(guard);
  }
});

// ---- 5. the registry rebuild (machine truth = ledger.jsonl) --------------------

test("rebuildOpenTasks: latest pr wins; gate_result merged/rolled_back removes; hold stays", () => {
  const ledger = [
    JSON.stringify({ ts: "1", taskId: "T-1", branch: "shift/T-1", prNumber: 1, prUrl: "u1", blocked: false }),
    JSON.stringify({ ts: "2", taskId: "T-2", branch: "shift/T-2", prNumber: 2, prUrl: "u2", blocked: false }),
    JSON.stringify({ ts: "3", taskId: "T-3", branch: "shift/T-3", prNumber: 3, prUrl: "u3" }),
    JSON.stringify({ ts: "4", actor: "shift-supervisor", type: "gate_result", refs: { task: "T-3", gate: "hold", status: "held" } }),
    JSON.stringify({ ts: "5", taskId: "T-1", branch: "shift/T-1", prNumber: 1, prUrl: "u1b", blocked: false }),
    JSON.stringify({ ts: "6", actor: "shift-supervisor", type: "gate_result", refs: { task: "T-1", status: "merged" } }),
    JSON.stringify({ ts: "7", actor: "shift-supervisor", type: "gate_result", refs: { task: "T-2", status: "rolled_back" } }),
    JSON.stringify({ ts: "8", taskId: "T-4", blocked: true, prNumber: 0 }), // blocked ⇒ never open
  ].join("\n");
  const file = join(base, "ledger.jsonl");
  writeFileSync(file, ledger + "\n");
  const map = rebuildOpenTasks(file);
  assert.deepEqual([...map.keys()], ["T-3"], `got: ${[...map.keys()].join(",")}`);
  assert.equal(map.get("T-3")?.prNumber, 3);
  assert.equal(map.get("T-3")?.branch, "shift/T-3");
});

test("appendGateEvent writes the §4.3 event shape to LEDGER_PATH", () => {
  const guard = withTestLedger();
  try {
    appendGateEvent("gate_result", { task: "T-9", gate: "hold", ci: "green" });
    appendGateEvent("rollback", { task: "T-9", pr: 4, reason: "test" });
    const lines = readFileSync(tmpLedger, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(first.actor, "shift-supervisor");
    assert.equal(first.type, "gate_result");
    assert.equal(first.ts, first.ts); // present, iso
    assert.ok(String(first.ts).endsWith("Z"));
    const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    assert.equal(second.type, "rollback");
    assert.deepEqual((second.refs as Record<string, unknown>).reason, "test");
  } finally {
    restoreLedger(guard);
  }
});

// test helpers ----------------------------------------------------------------

test("receipt header must match the entire task id and test-log fence must close", () => {
  const slip = slipFixture();
  const body = prBodyFor(slip);
  assert.equal(validateReceiptBlock(body.replace(`receipts — ${slip.id}`, `receipts — ${slip.id}0`), receiptContract(slip)).ok, false);
  const lines = body.split("\n");
  const close = lines.findLastIndex((line) => line.trim() === "```");
  lines.splice(close, 1);
  assert.ok(validateReceiptBlock(lines.join("\n"), receiptContract(slip)).gaps.includes("test-log fenced block is not closed"));
});

test("merged rollback fallback reverts remote main without touching the worker branch", async () => {
  const { execFileSync } = await import("node:child_process");
  const { revertMergedPr } = await import("../src/gates.js");
  const repo = join(base, "repo");
  const origin = join(base, "origin.git");
  mkdirSync(repo);
  const git = (args: string[], cwd = repo): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "--bare", origin]);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "rehearsal"]);
  git(["config", "user.email", "rehearsal@example.invalid"]);
  writeFileSync(join(repo, "feature.txt"), "base\n");
  git(["add", "feature.txt"]); git(["commit", "-m", "base"]);
  git(["remote", "add", "origin", origin]); git(["push", "origin", "main"]);
  git(["switch", "-c", "feature"]);
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  git(["commit", "-am", "feature"]);
  git(["switch", "main"]); git(["merge", "--no-ff", "feature", "-m", "merge feature"]);
  const merge = git(["rev-parse", "HEAD"]);
  git(["push", "origin", "main"]);
  git(["switch", "-c", "active-worker"]);
  const workerHead = git(["rev-parse", "HEAD"]);
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = await revertMergedPr(repo, 7, merge, { ...process.env, PATH: `${shimDir}:${process.env.PATH}` });
  assert.equal(result.ok, true, result.output);
  assert.equal(git(["branch", "--show-current"]), "active-worker");
  assert.equal(git(["rev-parse", "HEAD"]), workerHead);
  assert.equal(git(["--git-dir", origin, "show", "main:feature.txt"]), "base");
});
