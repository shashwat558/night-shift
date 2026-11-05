import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let ok = true;
const pass = message => console.log(`PASS ${message}`);
const fail = message => { console.error(`FAIL ${message}`); ok = false; };
const read = file => readFileSync(file, "utf8");

const readme = read("README.md");
for (const [needle, label] of [
  ["git clone https://github.com/shashwat558/night-shift.git", "clone command"],
  ["./scripts/bootstrap.sh", "bootstrap command"],
  ["docker compose -f ops/standalone-docker-compose.yml", "compose command"],
  ["node demo/run.mjs demo/night.yml --live", "demo command"],
  ["## What Switch does here", "Switch explanation"],
  ["## Honest limitations", "limitations"],
  ["```mermaid", "architecture diagram"],
]) readme.includes(needle) ? pass(`README contains ${label}`) : fail(`README missing ${label}`);

for (const file of ["ops/standalone-docker-compose.yml", "ops/.env.example", "scripts/bootstrap.sh", "docs/demo-shotlist.md"]) {
  existsSync(file) ? pass(`${file} present`) : fail(`${file} missing`);
}

const lint = spawnSync(process.execPath, ["demo/run.mjs", "demo/night.yml", "--lint"], { encoding: "utf8" });
if (lint.status === 0) pass("demo/night.yml schema lint");
else fail(`demo/night.yml schema lint: ${(lint.stderr || lint.stdout).trim()}`);

const shots = read("docs/demo-shotlist.md");
for (const phrase of ["Best Business Workflow", "November 7, 2026 at 11:59 PM IST", "repo URL", "demo video", "README"]) {
  shots.includes(phrase) ? pass(`submission checklist names ${phrase}`) : fail(`submission checklist missing ${phrase}`);
}

if (!ok) process.exit(1);
console.log("phase-6 checks complete");
