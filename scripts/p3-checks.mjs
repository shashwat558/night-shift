// scripts/p3-checks.mjs — offline verification for phase 3 (called by verify.sh).
//
// Checks (no AI calls, no network beyond localhost):
//   1. Gate command grammar: approve/rollback/hold parse; noise does not.
//   2. Receipt validation vs crew/receipt.schema.md using the REAL renderer:
//      clean body validates; missing field names itself; empty test-log;
//      files outside files_allowed; budget block (shape + overspend).
//   3. Decision table: approve WITHOUT CI green rejected (with the state in
//      the reply); FAIL receipt refused; missing field ⇒ needs-eyes; hold
//      stays draft; rollback honored.
//   4. Budget logic state machine: N-cap plans the roster; a deadline slip
//      lands blocked-with-reason and the night continues.
//   5. Gate registry: ledger rebuild (open/hold/closed states).
// Exits 0 when every check passes; non-zero on the first category failure.
// One PASS/FAIL line per check.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const DIST = join(ROOT, "supervisor", "dist");

let ok = true;
const pass = (m) => console.log(`PASS ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); ok = false; };

const gates = await import(`file://${join(DIST, "src", "gates.js")}`);
const night = await import(`file://${join(DIST, "src", "night.js")}`);
const prs = await import(`file://${join(DIST, "src", "prs.js")}`);

const slip = {
  id: "B-20261105-01",
  backlog_ref: "BACKLOG-1",
  title: "Add input validation to POST /pets",
  assignee: "shift-worker-1",
  scope: "Validate POST /pets body.",
  files_allowed: ["src/routes/pets.js"],
  acceptance: ["POST /pets with empty name returns 400"],
  time_budget_minutes: 20,
};
const facts = {
  filesTouched: ["src/routes/pets.js"],
  testPass: true,
  testOutput: "node --test 1..3\nok 1 validation\nALL-GREEN\n",
  startedAt: 1_000,
  finishedAt: 1_000 + 11 * 60_000,
  timedOut: false,
  providerOutput: "",
};

const contract = { taskId: slip.id, filesAllowed: slip.files_allowed, budgetMinutes: slip.time_budget_minutes };

// ── 1. gate command grammar ──────────────────────────────────────────────────
{
  const g = gates.parseGateCommand("@shift-supervisor approve B-20261105-01");
  if (g && g.verb === "approve" && g.taskId === "B-20261105-01" && g.reason === null) {
    pass("parseGateCommand: @mention approve parses");
  } else {
    fail(`parseGateCommand: expected approve/B-20261105-01, got ${JSON.stringify(g)}`);
  }
  const r = gates.parseGateCommand("rollback B-20261105-02 worker touched auth");
  if (r && r.verb === "rollback" && r.taskId === "B-20261105-02" && r.reason === "worker touched auth") {
    pass("parseGateCommand: rollback carries the reason");
  } else {
    fail(`parseGateCommand: rollback/reason broken — ${JSON.stringify(r)}`);
  }
  const h = gates.parseGateCommand("hold B-20261105-03");
  if (h && h.verb === "hold") {
    pass("parseGateCommand: hold parses");
  } else {
    fail(`parseGateCommand: hold broken — ${JSON.stringify(h)}`);
  }
  if (gates.parseGateCommand("tonight: do the thing") === null && gates.parseGateCommand("take B-1") === null) {
    pass("parseGateCommand: goals and worker acks are NOT gates");
  } else {
    fail("parseGateCommand: non-gate text parsed as a gate");
  }
}

// ── 2. receipts validation (real renderer round-trip) ─────────────────────────
{
  const body = prs.renderPrBody(slip, prs.renderReceipts(slip, facts, { found: true, summary: "wired validation", riskCall: "low — isolated route", deviations: "none" }), { ghRepo: "acme/petshop", provider: "opencode" });
  const check = gates.validateReceiptBlock(body, contract);
  if (check.ok && check.gaps.length === 0 && check.testPass === true) {
    pass("validateReceiptBlock: real-renderer body validates clean");
  } else {
    fail(`validateReceiptBlock: clean body flagged — ${check.gaps.join("; ")}`);
  }

  const gapped = body.replace(/- summary: .*\n/, "");
  const c2 = gates.validateReceiptBlock(gapped, contract);
  if (!c2.ok && c2.gaps.includes("missing field: summary")) {
    pass("validateReceiptBlock: missing field names itself exactly");
  } else {
    fail(`validateReceiptBlock: missing summary not named — ${c2.gaps.join("; ")}`);
  }

  const emptyTail = prs.renderPrBody(slip, prs.renderReceipts(slip, { ...facts, testOutput: "" }, { found: false }), { ghRepo: null, provider: "opencode" });
  const c3 = gates.validateReceiptBlock(emptyTail, contract);
  if (!c3.ok && c3.gaps.some((g) => g.startsWith("test-log fenced block is empty"))) {
    pass("validateReceiptBlock: empty test-log fence caught");
  } else {
    fail(`validateReceiptBlock: empty tail not caught — ${c3.gaps.join("; ")}`);
  }

  const outside = prs.renderPrBody(slip, prs.renderReceipts(slip, { ...facts, filesTouched: ["src/routes/pets.js", "src/auth.js"] }, { found: true, summary: "also touched auth", riskCall: "low — isolated", deviations: "none" }), { ghRepo: null, provider: "opencode" });
  const c4 = gates.validateReceiptBlock(outside, contract);
  if (!c4.ok && c4.gaps.some((g) => g.includes("outside the slip's files_allowed") && g.includes("src/auth.js"))) {
    pass("validateReceiptBlock: out-of-whitelist paths named");
  } else {
    fail(`validateReceiptBlock: scope breach missed — ${c4.gaps.join("; ")}`);
  }

  const overspent = body.replace("- budget: 11 / 20 min", "- budget: 25 / 20 min");
  const c5 = gates.validateReceiptBlock(overspent, contract);
  if (!c5.ok && c5.gaps.some((g) => g.includes("budget exceeded: spent 25 > 20 min"))) {
    pass("validateReceiptBlock: budget overshoot blocked");
  } else {
    fail(`validateReceiptBlock: overspend missed — ${c5.gaps.join("; ")}`);
  }
}

// ── 3. the decision table ─────────────────────────────────────────────────────
{
  const okReceipt = { ok: true, gaps: [], testPass: true, riskLevel: "low", declaredDeviations: false, filesTouched: [], budgetSpent: 11, budgetCap: 20 };
  const merge = gates.decideGate({ verb: "approve", taskId: "B-20261105-01", ciState: "green", ciDetail: "1 checks", receipt: okReceipt, hasOpenPr: true });
  if (merge.action === "merge") {
    pass("decision table: approve + receipts clean + CI green ⇒ merge");
  } else {
    fail(`decision table: green approve not merged — ${merge.action}`);
  }

  const refused = gates.decideGate({ verb: "approve", taskId: "B-20261105-01", ciState: "pending", ciDetail: "1 checks, still running", receipt: okReceipt, hasOpenPr: true });
  if (refused.action === "refuse_ci" && refused.reply.includes("pending") && refused.reply.includes("approve counts only with CI green")) {
    pass("decision table: approve WITHOUT CI green rejected, state named");
  } else {
    fail(`decision table: pending approve wasn't refused — ${refused.action}: ${refused.reply.slice(0, 80)}`);
  }

  const failReceipt = gates.decideGate({ verb: "approve", taskId: "B-20261105-01", ciState: "green", ciDetail: "1 checks", receipt: { ...okReceipt, testPass: false }, hasOpenPr: true });
  if (failReceipt.action === "refuse_receipt" && failReceipt.reply.includes("never merge")) {
    pass("decision table: FAIL receipt can never merge");
  } else {
    fail(`decision table: FAIL slipped through — ${failReceipt.action}`);
  }

  const gapped = gates.decideGate({
    verb: "approve", taskId: "B-20261105-01", ciState: "green", ciDetail: "1 checks",
    receipt: { ...okReceipt, ok: false, gaps: ["missing field: summary", "missing field: risk-call"] },
    hasOpenPr: true,
  });
  if (gapped.action === "refuse_receipt" && gapped.reply.includes("needs-eyes") && gapped.reply.includes("missing field: summary") && gapped.reply.includes("missing field: risk-call")) {
    pass("decision table: receipt gaps ⇒ needs-eyes naming the exact gaps");
  } else {
    fail(`decision table: needs-eyes path broken — ${gapped.action}: ${gapped.reply.slice(0, 120)}`);
  }

  const hold = gates.decideGate({ verb: "hold", taskId: "B-20261105-01", ciState: "green", ciDetail: "1 checks", receipt: okReceipt, hasOpenPr: true });
  const roll = gates.decideGate({ verb: "rollback", taskId: "B-20261105-01", ciState: "pending", ciDetail: "n checks", receipt: { ...okReceipt, ok: false, gaps: ["x"] }, hasOpenPr: true });
  if (hold.action === "hold" && roll.action === "rollback") {
    pass("decision table: hold stays draft; rollback honored regardless of CI");
  } else {
    fail(`decision table: hold/rollback wrong — ${hold.action}/${roll.action}`);
  }
}

// ── 4. budget state machine (plan + deadline → block + continue) ────────────────
{
  const slips = ["A", "B", "C", "D"].map((id) => ({ ...slip, id: `B-20261105-${id}` }));
  const plan = night.planNight(slips, { maxSlips: 3, graceMs: 1_000 });
  if (plan.take.length === 3 && plan.capped.length === 1 && plan.capped[0]?.slip.id === slips[3].id) {
    pass("night plan: cap N=3 takes 3, caps the 4th");
  } else {
    fail(`night plan: wrong split — take=${plan.take.length} capped=${plan.capped.length}`);
  }

  const results = await night.runBudgetedNight(
    ["X1", "X2", "X3"].map((id) => ({ ...slip, id: `B-20261105-${id}`, time_budget_minutes: 0 })),
    { maxSlips: 3, graceMs: 40 },
    (s) => (s.id.endsWith("X2")
      ? { p: new Promise((resolve) => setTimeout(resolve, 2_000)) }
      : { p: Promise.resolve({ blocked: false, reason: undefined }) }),
    {
      log: () => {},
      onDeadline: async () => {},
      outcomeOf: () => ({ status: "done", reason: null }),
    },
  );
  const byId = Object.fromEntries(results.outcomes.map((o) => [o.taskId, o.status]));
  if (byId[`B-20261105-X2`] === "deadline" && results.deadlineBlocked === 1 && byId[`B-20261105-X3`] === "done") {
    pass("budget state machine: deadline slip blocked-with-reason, night continues");
  } else {
    fail(`budget state machine: wrong outcomes — ${JSON.stringify(byId)}`);
  }

  const roster = night.nightRosterPost("outcomes:", results.outcomes);
  if (roster.includes("⏰ `B-20261105-X2`") && roster.includes("🛏") === false && roster.split("\n").length === 4) {
    pass("roster post: honest marks, one line per outcome");
  } else {
    fail(`roster post: broken — ${JSON.stringify(roster)}`);
  }
}

// ── 5. registry rebuild from the ledger ───────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "nightshift-p3-"));
  const file = join(dir, "ledger.jsonl");
  writeFileSync(file, [
    JSON.stringify({ ts: "t", taskId: "BO-1", branch: "shift/BO-1", prNumber: 1, prUrl: "u", blocked: false }),
    JSON.stringify({ ts: "t", taskId: "BO-2", branch: "shift/BO-2", prNumber: 2, prUrl: "u", blocked: false }),
    JSON.stringify({ ts: "t", actor: "shift-supervisor", type: "gate_result", refs: { task: "BO-2", status: "rolled_back" } }),
  ].join("\n") + "\n");
  const map = gates.rebuildOpenTasks(file);
  if (map.has("BO-1") && !map.has("BO-2") && map.get("BO-1")?.branch === "shift/BO-1") {
    pass("gate registry: ledger rebuild keeps open tasks, drops rolled back");
  } else {
    fail(`gate registry: rebuild wrong — ${[...map.keys()].join(",")}`);
  }
}

if (ok) {
  console.log(`ALL ${new Date().toISOString()}: p3-checks passed (offline)`);
  process.exit(0);
} else {
  console.error(`ALL ${new Date().toISOString()}: p3-checks FAILED`);
  process.exit(1);
}
