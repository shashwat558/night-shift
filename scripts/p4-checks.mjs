// Phase 4 offline contract: actual branch-diff scan and claim orderer tests.
import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, ["--test", "supervisor/dist/test/negotiation.test.js"], { encoding: "utf8" });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
console.log("PASS phase-4 fixture diff overlap scanner and claim orderer");
