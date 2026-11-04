// supervisor/test/prs.test.ts — receipts renderer + parser offline; the gh
// plumbing runs against a fake gh binary on a PATH shim dir (no GitHub).

import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderReceipt, renderReceipts, renderPrBody, createDraftPr, ciStatus } from "../src/prs.js";
import type { Slip } from "../src/slips.js";

let shimDir: string;
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "nightshift-prs-"));
  shimDir = join(base, "shim");
});

const SHIM_SHEBANG = "#!/usr/bin/env bash";

function slipFixture(overrides?: Partial<Slip>): Slip {
  return {
    id: "TEST-20260101-02",
    backlog_ref: "BACKLOG-3",
    title: "receipts test",
    assignee: "shift-worker-1",
    scope: "temp scope",
    files_allowed: ["src/feature.js"],
    acceptance: ["all good"],
    time_budget_minutes: 20,
    notes: "",
    ...overrides,
  };
}

function runFacts(overrides?: Partial<Parameters<typeof renderReceipts>[1]>): Parameters<typeof renderReceipts>[1] {
  return {
    filesTouched: ["src/feature.js"],
    testPass: true,
    testOutput: "npm-test 1..3 ok\nPETSHOP-TESTS-GREEN\n",
    startedAt: 1_000,
    finishedAt: 6_000 + 60_000, // ~1 measured minute
    timedOut: false,
    providerOutput: "",
    ...overrides,
  };
}

// ---- receipts block (crew/receipt.schema.md field order) --------------------

test("renderReceipts emits the schema field order and the honest overlays", () => {
  const slip = slipFixture();
  const tailLines = "suite ran\nall green";
  const block = renderReceipts(
    slip,
    runFacts({ testOutput: `header\ntail-a\n${tailLines}` }),
    {
      found: true,
      summary: "added feature.js",
      riskCall: "low — isolated",
      deviations: "none",
    },
  );
  const lines = block.split("\n");
  assert.equal(lines[0], `#### receipts — ${slip.id}`);
  const order = lines.map((l) => (/^\s*-\s*([\w-]+):/.exec(l) ?? [])[1]).filter(Boolean);
  const expected = ["summary", "files-touched", "tests", "test-log", "risk-call", "deviations", "budget"];
  const present = expected.filter((f) => order.includes(f));
  assert.deepEqual(present, expected);
  assert.equal(order.indexOf("summary"), 0);
  assert.ok(block.includes("- tests: PASS"));
  assert.ok(block.includes("- files-touched: src/feature.js"));
  assert.ok(block.includes(`- budget: 1 / ${slip.time_budget_minutes} min`), block);
  // test-log: fenced, raw tail lines PRESENT, no paraphrase
  const fenceIdx = lines.findIndex((l) => l === "```");
  const tailFence = lines.lastIndexOf("```");
  assert.ok(tailFence > fenceIdx);
  const logBody = lines.slice(fenceIdx + 1, tailFence).join("\n");
  assert.ok(logBody.includes("all green"));
  assert.ok(logBody.includes("tail-a"));
});

test("renderReceipts: FAIL run, timeout budget, and missing provider fields hold honest placeholders", () => {
  const slip = slipFixture();
  const block = renderReceipts(
    slip,
    runFacts({ testPass: false, timedOut: true, finishedAt: undefined, providerOutput: "no receipts here", filesTouched: [] }),
    { found: false },
  );
  assert.ok(block.includes("- tests: FAIL"));
  assert.ok(block.includes(`- budget: ${slip.time_budget_minutes} / ${slip.time_budget_minutes} min`));
  assert.ok(block.includes("none outside files_allowed"));
  assert.ok(block.includes("unfiled — headless run produced no risk statement"));
  assert.ok(block.includes(slip.title));
});

test("parseProviderReceipt finds the workers own block and its fields", () => {
  const slip = slipFixture();
  const out = [
    "working...",
    "```",
    `#### receipts — ${slip.id}`,
    "- summary: wired feedback loop",
    "- files-touched: src/room.js",
    "- tests: PASS",
    "- test-log: suite tail below",
    "- risk-call: medium — touches the allocator",
    "- deviations: none",
    "- budget: 11 / 20 min",
    "```",
  ].join("\n");
  const r = parseProviderReceipt(out, slip.id);
  assert.equal(r.found, true);
  assert.equal(r.summary, "wired feedback loop");
  assert.equal(r.riskCall, "medium — touches the allocator");
  assert.equal(r.deviations, "none");
  assert.equal(r.budgetClaimed, "11 / 20 min");
});

test("parseProviderReceipt: no block → found=false; mismatched id → not found", () => {
  assert.equal(parseProviderReceipt("plain text output", "TEST-20260101-01").found, false);
  const wrongId = "#### receipts — OTHER-20260101-09\n- summary: x";
  assert.equal(parseProviderReceipt(wrongId, "TEST-20260101-01").found, false);
});

test("renderPrBody: receipts block sits last, title/meta present", () => {
  const slip = slipFixture();
  const receipts = renderReceipts(slip, runFacts(), { found: false });
  const body = renderPrBody(slip, receipts, { ghRepo: "acme/petshop", provider: "opencode" });
  assert.ok(body.includes("## receipts test"));
  assert.ok(body.includes(`Branch: \`shift/${slip.id}\``));
  assert.ok(body.includes("draft by the night-shift supervisor"));
  const endsWith = body.split("\n").filter(Boolean).pop() ?? "";
  assert.ok(endsWith.startsWith("- budget:"), `end: ${endsWith}`);
  const blockIdx = body.indexOf(`#### receipts — ${slip.id}`);
  assert.ok(blockIdx > 0);
  assert.ok(body.indexOf("- budget:") > blockIdx);
});

// ---- fake gh plumbing --------------------------------------------------------

function writeGhShim(): void {
  mkdirSync(shimDir, { recursive: true });
  // behavior is chosen by env vars (NSP_GH_*) injected with the PATH — no
  // fragile quoting inside the script itself
  const script = [
    SHIM_SHEBANG,
    'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
    '  echo "$NSP_GH_CREATE_OUT"',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    '  echo "$NSP_GH_VIEW_JSON"',
    "  exit 0",
    "fi",
    "echo unexpected gh call: $* >&2",
    "exit 3",
  ].join("\n");
  writeFileSync(join(shimDir, "gh"), script + "\n");
  chmodSync(join(shimDir, "gh"), 0o750);

  // fake git shim for push tests
  const gitScript = [
    SHIM_SHEBANG,
    'if [ "$1" = "push" ]; then',
    '  [ "$NSP_GH_PUSH_OK" = "1" ] || { echo "push denied: forgery CI" >&2; exit 1; }',
    "  exit 0",
    "fi",
    'exec /usr/bin/git "$@"',
  ].join("\n");
  writeFileSync(join(shimDir, "git"), gitScript + "\n");
  chmodSync(join(shimDir, "git"), 0o750);
}

const OUT1 = "Created draft PR https://github.com/acme/petshop/pull/7";

function envWithGhShim(opts: { pushOk: boolean; createOut?: string; viewJson?: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    NSP_GH_PUSH_OK: opts.pushOk ? "1" : "0",
    NSP_GH_CREATE_OUT: opts.createOut ?? "",
    NSP_GH_VIEW_JSON: opts.viewJson ?? "",
  };
}

test("createDraftPr: push + pr create → pr url and number parsed", async () => {
  writeGhShim();
  const slip = slipFixture();
  const res = await createDraftPr(base, slip, runFacts(), {
    provider: "opencode",
    ghRepo: null,
    envOverride: envWithGhShim({ pushOk: true, createOut: OUT1 }),
  });
  assert.equal(res.ok, true, res.output);
  assert.equal(res.prUrl, "https://github.com/acme/petshop/pull/7");
  assert.equal(res.prNumber, 7);
});

test("createDraftPr: failed push surfaces the reason and no pr", async () => {
  writeGhShim();
  const res = await createDraftPr(base, slipFixture(), runFacts(), {
    provider: "opencode",
    ghRepo: null,
    envOverride: envWithGhShim({ pushOk: false, createOut: OUT1 }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.prUrl, null);
  assert.ok(res.output.includes("push failed"));
});

test("createDraftPr: receipt overlays land INSIDE the body parsed by gh", async () => {
  const slip = slipFixture();
  const attempt = parseProviderReceipt(`#### receipts — ${slip.id}\n- summary: fake summary`, slip.id);
  const body = renderPrBody(slip, renderReceipts(slip, runFacts(), attempt), { ghRepo: null, provider: "opencode" });
  assert.ok(body.includes("- summary: fake summary"));
  assert.ok(body.includes("- tests: PASS"));
});

test("ciStatus: green / red / pending / none rollup states", async () => {
  const mkJson = (checks: object[]): string => JSON.stringify({ statusCheckRollup: checks });
  writeGhShim();
  const green = await ciStatus(base, 7, envWithGhShim({ pushOk: true, viewJson: mkJson([{ status: "COMPLETED", conclusion: "SUCCESS" }]) }));
  assert.equal(green.state, "green");

  writeGhShim();
  const red = await ciStatus(base, 7, envWithGhShim({ pushOk: true, viewJson: mkJson([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]) }));
  assert.equal(red.state, "red");

  writeGhShim();
  const pending = await ciStatus(base, 7, envWithGhShim({ pushOk: true, viewJson: mkJson([{ status: "IN_PROGRESS", conclusion: undefined }]) }));
  assert.equal(pending.state, "pending");

  writeGhShim();
  const none = await ciStatus(base, 7, envWithGhShim({ pushOk: true, viewJson: mkJson([]) }));
  assert.equal(none.state, "none");
});
