// supervisor/test/spawner.test.ts — offline: synthetic target repo (bare
// origin + locally cloned worktree), a fake provider binary on a
// PATH shim dir, and a budget override for the kill-switch.
// No AI is ever invoked; no network beyond the local git file transports.

import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runWorker, providerPrompt, providerArgs, rawTestLogTail } from "../src/spawner.js";
import type { Slip } from "../src/slips.js";
import type { Config } from "../src/env.js";

let base: string;
let shimDir: string;
let targetDir: string;
let cfg: Config;
function sh(args: string[], cwd: string): void {
  execSync(args.join(" "), { cwd, stdio: "ignore" });
}

function makeTarget(): void {
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  mkdirSync(seed);
  sh(["git", "init", "--bare", "-b", "main", origin], base);
  sh(["git", "init", "-b", "main", seed], seed);
  sh(["git", "-C", seed, "config", "user.email", "seed@test.invalid"], seed);
  sh(["git", "-C", seed, "config", "user.name", "seed"], seed);
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({
      name: "petshop-fixture",
      version: "0.0.0",
      scripts: {
        test: "node run-tests.js",
      },
    }),
  );
  writeFileSync(
    join(seed, "run-tests.js"),
    "if (process.env.NSP_TEST_MODE === 'fail') { console.error('PETSHOP-TESTS-FAIL'); process.exit(1); }\nCONSOLE_RUNS = 3; console.log('PETSHOP-NPM-TEST-GREEN');\n",
  );
  sh(["git", "-C", seed, "add", "."], seed);
  sh(["git", "-C", seed, "commit", '-m', "'seed commit'"], seed);
  sh(["git", "-C", seed, "remote", "add", "origin", origin], seed);
  sh(["git", "-C", seed, "push", "-q", "-u", "origin", "main"], seed);
  targetDir = join(base, "target");
  sh(["git", "clone", "-q", origin, targetDir], base);
  sh(["git", "-C", targetDir, "config", "user.email", "night-lead@shift.invalid"], targetDir);
  sh(["git", "-C", targetDir, "config", "user.name", "night-lead"], targetDir);

  shimDir = join(base, "shim");
  mkdirSync(shimDir);
  cfg = {
    apiBase: "http://127.0.0.1:9",
    gatewayBase: "http://127.0.0.1:9",
    agentName: "shift-supervisor",
    agentId: "sup-test",
    agentKey: "sk-test",
    room: "overnight-crew",
    roomId: "room-1",
    roomIds: ["room-1"],
    crewPrefix: "nightshift",
    targetDir,
    repoRoot: "/tmp/opencode",
    ghRepo: null,
    provider: "opencode",
    connectionId: "conn-1",
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "nightshift-spawn-"));
  makeTarget();
});

const SHIM_SHEBANG = "#!/usr/bin/env bash";

function slipFixture(overrides?: Partial<Slip>): Slip {
  return {
    id: "TEST-20260101-01",
    backlog_ref: "BACKLOG-3",
    title: "fake provider writes a feature file",
    assignee: "shift-worker-1",
    scope: "add one module file under src/",
    files_allowed: ["src/feature.js"],
    acceptance: ["feature.js exists"],
    time_budget_minutes: 5,
    notes: "",
    ...overrides,
  };
}

function writeFakeProvider(slip: Slip, body: string, binary = "opencode"): void {
  // A fake provider binary: prints a receipts block, writes a file, and
  // commits it — the exact shape the real headless provider is asked for
  const script = [
    SHIM_SHEBANG,
    'echo "FAKE-PROVIDER-START"',
    "mkdir -p src",
    `echo "module.exports = () => 'feature';" > src/feature.js`,
    `git add src/feature.js && git commit -q -m "feat(${slip.id}): feature"`,
    `cat <<'EOF'`,
    body.replace(/\n/g, "\n"),
    "EOF",
    'echo "FAKE-PROVIDER-EXIT"',
    "sleep ${NSP_FAKE_SLEEP:-0}",
  ].join("\n");
  writeFileSync(join(shimDir, binary), script + "\n");
  chmodSync(join(shimDir, binary), 0o750);
}

function envWithShim(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` };
}
void envWithShim;

// ---- provider prompt / args -------------------------------------------------

test("providerArgs maps OpenCode, Codex, and Claude to headless commands", () => {
  assert.deepEqual(providerArgs("opencode", "hi"), ["run", "hi"]);
  assert.deepEqual(providerArgs("codex", "hi"), [
    "exec",
    "--approve-for-me",
    "--sandbox", "workspace-write",
    "--ephemeral",
    "--color", "never",
    "hi",
  ]);
  assert.deepEqual(providerArgs("claude", "hi"), ["-p", "hi"]);
  assert.equal(providerArgs("fake" as never, "hi"), null);
});

test("providerPrompt carries the slip verbatim, the whitelist, and the receipts shape", () => {
  const slip = slipFixture();
  const prompt = providerPrompt(slip, 66);
  assert.ok(prompt.includes("shift/" + slip.id));
  assert.ok(prompt.includes("66 minutes"));
  assert.ok(prompt.includes("files_allowed"));
  assert.ok(prompt.includes("- src/feature.js"));
  assert.ok(prompt.includes(`#### receipts — ${slip.id}`));
  assert.ok(prompt.includes("- test-log:"));
  assert.ok(prompt.includes("- budget:"));
  assert.ok(prompt.includes("receipt rejected:"));
});

test("rawTestLogTail returns the actual LAST lines, raw", () => {
  const out = "line1\nline2\nline3";
  assert.equal(rawTestLogTail(out, 2), "line2\nline3");
  assert.equal(rawTestLogTail(out, 10), out);
});

// ---- runWorker --------------------------------------------------------------

test("runWorker: clean repo, fake provider runs, truth collected, PR-grade run", async () => {
  process.env.NSP_TEST_MODE = "";
  process.env.NSP_FAKE_SLEEP = "0";
  const slip = slipFixture();
  writeFakeProvider(
    slip,
    [
      `#### receipts — ${slip.id}`,
      `- summary: added src/feature.js`,
      `- files-touched: src/feature.js`,
      `- tests: PASS`,
      `- test-log: raw tail supplied by the supervisor`,
      `- risk-call: low — isolated module, no consumer changes`,
      `- deviations: none`,
      `- budget: 2 / ${slip.time_budget_minutes} min`,
    ].join("\n"),
  );
  // splice the shim dir into PATH for the child processes
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
  try {
    const wip = await runWorker(cfg, slip, () => {}, {});
    assert.equal(wip.blocked, false, `unexpected block: ${wip.reason ?? ""}`);
    assert.equal(wip.branch, `shift/${slip.id}`);
    assert.ok(wip.providerOutput.includes("FAKE-PROVIDER-START"));
    assert.deepEqual(wip.filesTouched, ["src/feature.js"]);
    assert.ok(wip.diff.includes("module.exports"));
    assert.equal(wip.testPass, true);
    assert.ok(wip.testOutput.includes("PETSHOP-NPM-TEST-GREEN"));
    assert.ok(wip.finishedAt !== undefined && wip.finishedAt > wip.startedAt);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("runWorker: Codex provider uses the same bounded worker contract", async () => {
  process.env.NSP_TEST_MODE = "";
  process.env.NSP_FAKE_SLEEP = "0";
  const slip = slipFixture();
  writeFakeProvider(slip, `#### receipts — ${slip.id}\n- summary: codex fixture`, "codex");
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
  try {
    const wip = await runWorker({ ...cfg, provider: "codex" }, slip, () => {}, {});
    assert.equal(wip.blocked, false, `unexpected block: ${wip.reason ?? ""}`);
    assert.ok(wip.providerOutput.includes("FAKE-PROVIDER-START"));
    assert.deepEqual(wip.filesTouched, ["src/feature.js"]);
    assert.equal(wip.testPass, true);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("runWorker: dirty worktree blocks with the reason and does not touch git", async () => {
  writeFileSync(join(targetDir, "Untracked-dirt.txt"), "dirty");
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
  writeFakeProvider(slipFixture(), "SHOULD-NOT-RUN");
  try {
    const wip = await runWorker(cfg, slipFixture(), () => {}, {});
    assert.equal(wip.blocked, true);
    assert.ok(wip.reason!.includes("worktree not clean"), wip.reason);
    assert.ok(wip.providerOutput === "");
  } finally {
    process.env.PATH = savedPath;
  }
});

test("runWorker: budget kill-switch (SIGTERM at the override, blocked with reason)", async () => {
  const slip = slipFixture();
  writeFakeProvider(slip, "SHOULD-BE-KILLED");
  const savedPath = process.env.PATH;
  const savedSleep = process.env.NSP_FAKE_SLEEP;
  process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
  process.env.NSP_FAKE_SLEEP = "30"; // the provider outlives the override
  try {
    const wip = await runWorker(cfg, slip, () => {}, { budgetMsOverride: 1600 });
    assert.equal(wip.timedOut, true);
    assert.equal(wip.blocked, true);
    assert.ok(wip.reason!.includes("budget"), wip.reason ?? "");
  } finally {
    process.env.PATH = savedPath;
    process.env.NSP_FAKE_SLEEP = savedSleep;
  }
});

test("runWorker: red test run lands in testPass=false with the raw tail intact", async () => {
  process.env.NSP_TEST_MODE = "fail";
  process.env.NSP_FAKE_SLEEP = "0";
  const slip = slipFixture();
  writeFakeProvider(slip, "#### receipts — ignored");
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
  try {
    const wip = await runWorker(cfg, slip, () => {}, {});
    assert.equal(wip.blocked, false, `unexpected block: ${wip.reason ?? ""}`);
    assert.equal(wip.testPass, false);
    assert.ok(wip.testOutput.includes("PETSHOP-TESTS-FAIL"));
  } finally {
    delete process.env.NSP_TEST_MODE;
    process.env.PATH = savedPath;
  }
});

test("runWorker: unknown provider name returns the block reason immediately", async () => {
  const wip = await runWorker({ ...cfg, provider: "made-up" as never }, slipFixture(), () => {});
  assert.equal(wip.blocked, true);
  assert.ok(wip.reason!.includes("unknown provider"));
});

void randomUUID;

test("runWorker: outer deadline kills the provider group and skips later commands", async () => {
  const slip = slipFixture();
  writeFakeProvider(slip, "waiting for cancellation");
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
  process.env.NSP_FAKE_SLEEP = "60";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    const start = Date.now();
    const result = await runWorker(cfg, slip, () => {}, { signal: controller.signal });
    assert.equal(result.blocked, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.testPass, false);
    assert.ok(Date.now() - start < 3000, "cancelled provider must settle before another slip starts");
  } finally {
    clearTimeout(timer);
    process.env.PATH = savedPath;
    process.env.NSP_FAKE_SLEEP = "0";
  }
});
