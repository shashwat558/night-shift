#!/usr/bin/env node
import { configFromFile } from "./env.js";
import { SwitchClient } from "./switchclient.js";
import { publishShiftReport } from "./report.js";

if (process.argv[2] !== "report") {
  console.error("usage: supervisor report");
  process.exit(2);
}
const cfg = configFromFile();
if (!cfg.roomId) throw new Error("SWITCH_ROOM_ID is required for report posting");
const client = new SwitchClient(cfg, {});
const artifact = await publishShiftReport(cfg.repoRoot, "cli", content => client.postMessage(cfg.roomId as string, content));
console.log(`${artifact.reused ? "reused" : "posted"} ${artifact.relativeFile}`);
