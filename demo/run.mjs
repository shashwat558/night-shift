#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const configPath = resolve(args.find(a => !a.startsWith("--")) ?? join(ROOT, "demo", "night.yml"));
const live = args.includes("--live");
const lintOnly = args.includes("--lint");
const started = Date.now();

function fail(message) { console.error(`DEMO FAIL ${message}`); process.exit(1); }
function pass(message) { console.log(`DEMO PASS ${message}`); }
function run(command, argv, cwd, options = {}) {
  const result = spawnSync(command, argv, { cwd, encoding: "utf8", timeout: options.timeout ?? 120_000, env: { ...process.env, ...(options.env ?? {}) } });
  if (!options.allowFailure && result.status !== 0) fail(`${command} ${argv.join(" ")}: ${(result.stderr || result.stdout).trim().slice(-800)}`);
  return result;
}

function parseNight(text) {
  const config = { slips: [] };
  let current = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    let match = /^([a-z_]+):\s*(.*)$/.exec(raw);
    if (match && match[1] !== "slips") { config[match[1]] = match[2]; continue; }
    match = /^  - id:\s*(\S+)\s*$/.exec(raw);
    if (match) { current = { id: match[1] }; config.slips.push(current); continue; }
    match = /^    ([a-z_]+):\s*(.+)\s*$/.exec(raw);
    if (match && current) { current[match[1]] = match[2]; continue; }
    if (!/^slips:\s*$/.test(raw)) throw new Error(`unsupported line: ${raw}`);
  }
  config.version = Number(config.version);
  config.max_runtime_seconds = Number(config.max_runtime_seconds);
  return config;
}

function validateNight(config) {
  const errors = [];
  if (config.version !== 1) errors.push("version must be 1");
  if (!config.name || !config.goal) errors.push("name and goal are required");
  if (!Number.isInteger(config.max_runtime_seconds) || config.max_runtime_seconds < 1 || config.max_runtime_seconds > 600) errors.push("max_runtime_seconds must be 1..600");
  if (config.slips.length !== 3) errors.push("exactly three slips are required");
  const outcomes = config.slips.map(s => s.outcome).sort().join(",");
  if (outcomes !== "collision,merge,rollback") errors.push("outcomes must be merge, rollback, and collision exactly once");
  const ids = new Set();
  for (const slip of config.slips) {
    for (const key of ["id", "title", "worker", "outcome", "file", "content"]) if (!slip[key]) errors.push(`${slip.id ?? "slip"}: ${key} required`);
    if (ids.has(slip.id)) errors.push(`duplicate id ${slip.id}`);
    ids.add(slip.id);
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(slip.id ?? "")) errors.push(`invalid id ${slip.id}`);
    if ((slip.file ?? "").startsWith("/") || (slip.file ?? "").includes("..")) errors.push(`${slip.id}: file must be relative`);
    if (slip.outcome === "rollback" && !slip.rollback_reason) errors.push(`${slip.id}: rollback_reason required`);
    if (slip.outcome === "collision" && !slip.collide_with) errors.push(`${slip.id}: collide_with required`);
  }
  const collision = config.slips.find(s => s.outcome === "collision");
  const opponent = config.slips.find(s => s.id === collision?.collide_with);
  if (collision && (!opponent || opponent.file !== collision.file)) errors.push("collision slip must name an existing slip with the same file");
  return errors;
}

let night;
try { night = parseNight(readFileSync(configPath, "utf8")); }
catch (error) { fail(`cannot parse ${configPath}: ${error.message}`); }
const schemaErrors = validateNight(night);
if (schemaErrors.length) fail(schemaErrors.join("; "));
pass("night.yml schema: three bounded slips with merge, rollback, and collision");
if (lintOnly) process.exit(0);

const dist = join(ROOT, "supervisor", "dist", "src");
if (!existsSync(join(dist, "gates.js"))) fail("supervisor is not built; run npm run build --prefix supervisor");
const [{ renderReceipts }, { validateReceiptBlock, decideGate }, { scanCollisions, parseClaim, decideClaims }, { renderShiftReport }] = await Promise.all([
  import(pathToFileURL(join(dist, "prs.js"))),
  import(pathToFileURL(join(dist, "gates.js"))),
  import(pathToFileURL(join(dist, "negotiation.js"))),
  import(pathToFileURL(join(dist, "report.js"))),
]);

const target = join(ROOT, "target");
if (!existsSync(join(target, ".git"))) fail("target repo missing; run ./scripts/bootstrap.sh");
if (!existsSync(join(target, "node_modules"))) run("npm", ["ci"], target, { timeout: 180_000 });

const scratch = mkdtempSync(join(tmpdir(), "nightshift-demo-"));
const seed = join(scratch, "seed");
const origin = join(scratch, "origin.git");
const work = join(scratch, "work");
mkdirSync(seed);
const remoteMain = run("git", ["rev-parse", "--verify", "refs/remotes/origin/main"], target, { allowFailure: true });
const sourceRef = remoteMain.status === 0 ? "refs/remotes/origin/main" : "refs/heads/main";
const archive = join(scratch, "target.tar");
run("git", ["archive", "--format=tar", "-o", archive, sourceRef], target);
run("tar", ["-xf", archive, "-C", seed], ROOT);
run("git", ["init", "-q", "-b", "main"], seed);
run("git", ["config", "user.name", "Night Shift Demo"], seed);
run("git", ["config", "user.email", "demo@night-shift.local"], seed);
run("git", ["add", "."], seed);
run("git", ["commit", "-qm", "demo baseline"], seed);
run("git", ["init", "-q", "--bare", origin], ROOT);
run("git", ["remote", "add", "origin", origin], seed);
run("git", ["push", "-q", "-u", "origin", "main"], seed);
run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], origin);
run("git", ["clone", "-q", origin, work], ROOT);
run("git", ["config", "user.name", "Night Shift Demo"], work);
run("git", ["config", "user.email", "demo@night-shift.local"], work);
symlinkSync(join(target, "node_modules"), join(work, "node_modules"), "dir");

const events = [];
let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 10, 6, 9, 0, tick++)).toISOString();
const roomPosts = [];
async function post(message) {
  const marked = `[scripted demo] ${message}`;
  roomPosts.push(marked);
  if (!live) { console.log(marked); return; }
  const env = Object.fromEntries(readFileSync(join(ROOT, "supervisor", ".env"), "utf8").split("\n").filter(l => /^[A-Z][A-Z0-9_]*=/.test(l)).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const response = await fetch(`${env.SWITCH_API}/agents/${env.SWITCH_AGENT_ID}/message`, { method: "POST", headers: { authorization: `Bearer ${env.SWITCH_AGENT_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ room_id: env.SWITCH_ROOM_ID, content: marked }) });
  if (!response.ok) fail(`Switch room post returned ${response.status}`);
}

await post(`tonight: ${night.goal}`);
events.push({ ts: stamp(), actor: "shift-supervisor", type: "goal_received", refs: { room: "overnight-crew", demo: true }, note: night.goal });
await post(`night-lead wrote 3 slips: ${night.slips.map(s => s.id).join(", ")}`);

const prepared = new Map();
for (let index = 0; index < night.slips.length; index++) {
  const item = night.slips[index];
  const branch = `shift/${item.id}`;
  run("git", ["checkout", "-q", "-B", branch, "main"], work);
  const file = join(work, item.file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${item.content}\n`);
  const test = run("npm", ["test"], work, { timeout: 120_000 });
  run("git", ["add", item.file], work);
  run("git", ["commit", "-qm", `${item.id}: ${item.title}`], work);
  run("git", ["push", "-q", "-u", "origin", branch], work);
  const slip = { id: item.id, backlog_ref: `DEMO-${index + 1}`, title: item.title, assignee: item.worker, scope: item.title, files_allowed: [item.file], acceptance: ["target test suite passes"], time_budget_minutes: 2 };
  const receipts = renderReceipts(slip, { filesTouched: [item.file], testPass: true, testOutput: test.stdout, startedAt: 0, finishedAt: 30_000, timedOut: false, providerOutput: "" }, { found: true, summary: item.title, riskCall: "low — isolated scripted demo file", deviations: "none" });
  const receipt = validateReceiptBlock(receipts, { taskId: item.id, filesAllowed: [item.file], budgetMinutes: 2 });
  if (!receipt.ok) fail(`${item.id} receipt rejected: ${receipt.gaps.join("; ")}`);
  prepared.set(item.id, { item, slip, branch, receipt });
  events.push({ ts: stamp(), taskId: item.id, worker: item.worker, branch, prUrl: null, prNumber: 900 + index, testPass: true, blocked: false, budgetMin: 2, spentMin: 0.5 });
  await post(`${item.worker} finished ${item.id}; tests PASS; receipts clean; draft demo PR #${900 + index}`);
}
pass("all three candidate branches passed the real target test suite and receipt validation");

const collisionItem = night.slips.find(s => s.outcome === "collision");
const firstItem = night.slips.find(s => s.id === collisionItem.collide_with);
const collisionTasks = [firstItem, collisionItem].map((item, index) => ({ taskId: item.id, branch: `shift/${item.id}`, prNumber: 900 + index, prUrl: null }));
const collisions = await scanCollisions(work, collisionTasks);
if (collisions.length !== 1 || !collisions[0].paths.includes(collisionItem.file)) fail("actual branch diff did not expose the configured collision");
const claims = [
  parseClaim(`claim ${firstItem.id} first ${firstItem.id} on ${collisionItem.file}\nland the base candidate first`, firstItem.id, 1),
  parseClaim(`claim ${collisionItem.id} first ${firstItem.id} on ${collisionItem.file}\nrebase the second candidate after it`, collisionItem.id, 1),
];
if (claims.some(c => !c)) fail("scripted collision claims did not parse");
const order = decideClaims(collisions[0], claims);
if (order.kind !== "order") fail(`collision negotiation escalated: ${order.reason}`);
events.push({ ts: stamp(), actor: "shift-supervisor", type: "negotiation_result", refs: { tasks: order.order, path: order.path, status: "agreed", demo: true } });
await post(`file-collision on ${order.path}; workers agreed ${order.order.join(" -> ")}`);
pass(`actual diff collision negotiated in order ${order.order.join(" -> ")}`);

const mergeItem = night.slips.find(s => s.outcome === "merge");
const rollbackItem = night.slips.find(s => s.outcome === "rollback");
for (const item of [mergeItem, rollbackItem, collisionItem]) {
  const preparedItem = prepared.get(item.id);
  const verb = item.outcome === "rollback" ? "rollback" : "approve";
  const decision = decideGate({ verb, taskId: item.id, ciState: "green", ciDetail: "local deterministic suite", receipt: preparedItem.receipt, hasOpenPr: true });
  const expected = item.outcome === "rollback" ? "rollback" : "merge";
  if (decision.action !== expected) fail(`${item.id} gate chose ${decision.action}, expected ${expected}`);
}

run("git", ["checkout", "-q", "main"], work);
run("git", ["merge", "-q", "--no-ff", `shift/${mergeItem.id}`, "-m", `merge ${mergeItem.id}`], work);
events.push({ ts: stamp(), actor: "shift-supervisor", type: "merge", refs: { task: mergeItem.id, pr: 900 } });
await post(`approve ${mergeItem.id}: receipts clean, CI green, merged`);

run("git", ["push", "-q", "origin", "--delete", `shift/${rollbackItem.id}`], work);
events.push({ ts: stamp(), actor: "shift-supervisor", type: "rollback", refs: { task: rollbackItem.id, why: rollbackItem.rollback_reason } });
await post(`rollback ${rollbackItem.id}: ${rollbackItem.rollback_reason}; branch deleted`);

run("git", ["checkout", "-q", `shift/${collisionItem.id}`], work);
const rebase = run("git", ["rebase", "main"], work, { allowFailure: true });
if (rebase.status === 0) fail("deliberate collision unexpectedly rebased without a conflict");
writeFileSync(join(work, collisionItem.file), `${mergeItem.content}\n${collisionItem.content}\n`);
run("git", ["add", collisionItem.file], work);
run("git", ["rebase", "--continue"], work, { env: { GIT_EDITOR: "true" } });
run("npm", ["test"], work, { timeout: 120_000 });
run("git", ["checkout", "-q", "main"], work);
run("git", ["merge", "-q", "--no-ff", `shift/${collisionItem.id}`, "-m", `merge ${collisionItem.id}`], work);
events.push({ ts: stamp(), actor: "shift-supervisor", type: "merge", refs: { task: collisionItem.id, pr: 902 } });
await post(`approve ${collisionItem.id}: rebased in agreed order, re-tested, merged`);

const report = renderShiftReport(events, "2026-11-06");
if (!report.includes("Merged: **2** · Rolled back: **1**")) fail("final report totals are wrong");
await post(report);
pass("final ledger replay reports 2 merged, 1 rolled back, and per-worker trust");

const elapsed = (Date.now() - started) / 1000;
if (elapsed > night.max_runtime_seconds) fail(`runtime ${elapsed.toFixed(1)}s exceeded ${night.max_runtime_seconds}s`);
pass(`end-to-end scripted night completed in ${elapsed.toFixed(1)}s (${live ? "live Switch room" : "offline transcript"})`);
