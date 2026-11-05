// Phase 5: golden ledger replay plus rebuild/replay from a scratch git clone.
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const focused = spawnSync(process.execPath, ["--test", "supervisor/dist/test/report.test.js", "supervisor/dist/test/clock.test.js"], { cwd: ROOT, encoding: "utf8" });
if (focused.status !== 0) {
  console.error(focused.stdout, focused.stderr);
  process.exit(1);
}
console.log("PASS phase-5 golden report, append-only ledger, idempotency, and accelerated clock");

const base = mkdtempSync(join(tmpdir(), "nightshift-p5-clone-"));
const clone = join(base, "repo");
const git = spawnSync("git", ["clone", "-q", "--no-hardlinks", ROOT, clone], { encoding: "utf8" });
if (git.status !== 0) {
  console.error(git.stderr);
  process.exit(1);
}
symlinkSync(join(ROOT, "supervisor", "node_modules"), join(clone, "supervisor", "node_modules"), "dir");
const build = spawnSync("npm", ["run", "build", "--prefix", "supervisor"], { cwd: clone, encoding: "utf8" });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  process.exit(1);
}
const replay = `
  import { readLedger } from ${JSON.stringify(`file://${join(clone, "supervisor", "dist", "src", "ledger.js")}`)};
  import { renderShiftReport } from ${JSON.stringify(`file://${join(clone, "supervisor", "dist", "src", "report.js")}`)};
  import { readFileSync } from "node:fs";
  const fixture = ${JSON.stringify(join(clone, "supervisor", "test", "fixtures", "report-ledger.jsonl"))};
  const golden = ${JSON.stringify(join(clone, "supervisor", "test", "fixtures", "report-golden.md"))};
  const { entries, invalidLines } = readLedger(fixture);
  if (renderShiftReport(entries, "2026-11-06", invalidLines) !== readFileSync(golden, "utf8")) process.exit(1);
`;
const replayed = spawnSync(process.execPath, ["--input-type=module", "-e", replay], { encoding: "utf8" });
if (replayed.status !== 0) {
  console.error(replayed.stdout, replayed.stderr);
  process.exit(1);
}
console.log("PASS phase-5 scratch-clone ledger replay matches golden report");
