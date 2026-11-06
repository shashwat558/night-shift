import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let ok = true;
const pass = message => console.log(`PASS ${message}`);
const fail = message => { console.error(`FAIL ${message}`); ok = false; };

const policy = readFileSync("crew/nightshift.policy.yml", "utf8");
for (const field of ["max_changed_files:", "max_budget_minutes:", "reviewer_required:", "blocked_paths:", "review_paths:"]) {
  policy.includes(field) ? pass(`trust policy declares ${field}`) : fail(`trust policy missing ${field}`);
}

const liveTest = readFileSync("docs/phase-7-live-test.md", "utf8");
const transcript = JSON.parse(readFileSync("docs/phase-7-room-transcript.json", "utf8"));
liveTest.includes("77a2eef54f5c") && transcript.posts.some(post => post.id === "boujb9myybbqdjfzeqh6r7rqqc")
  ? pass("live Switch transcript includes the real GitHub inspection")
  : fail("live Switch transcript is missing the real GitHub inspection");

const tests = spawnSync(process.execPath, ["--test", "supervisor/dist/test/trust.test.js", "supervisor/dist/test/gates.test.js"], { encoding: "utf8" });
if (tests.status === 0) pass("commit-bound evidence, policy, reviewer, and gate regressions");
else fail((tests.stderr || tests.stdout).trim().slice(-1200));

const demo = spawnSync(process.execPath, ["demo/run.mjs", "demo/night.yml", "--offline"], { encoding: "utf8", timeout: 120_000 });
const output = `${demo.stdout}\n${demo.stderr}`;
for (const [pattern, label] of [
  [/trust-reviewer DEMO-02: challenge/, "reviewer challenge visible"],
  [/policy block/, "blocked migration visible"],
  [/approval expired for DEMO-03/, "stale approval invalidated"],
  [/evidence `[a-f0-9]{16}`/, "evidence fingerprint visible"],
  [/DEMO PASS end-to-end scripted night completed/, "accelerated trust loop completes"],
]) pattern.test(output) ? pass(`demo ${label}`) : fail(`demo missing ${label}`);
if (demo.status !== 0) fail(`demo exited ${demo.status}`);

if (!ok) process.exit(1);
console.log("phase-7 trust-control checks complete");
