import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let ok = true;
const pass = message => console.log(`PASS ${message}`);
const fail = message => { console.error(`FAIL ${message}`); ok = false; };
const env = Object.fromEntries(readFileSync("ops/.env", "utf8").split(/\r?\n/)
  .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

for (const file of ["scripts/connect-slack.mjs", "ops/slack.env.example", "docs/messaging-apps.md"]) {
  try { readFileSync(file); pass(`${file} present`); } catch { fail(`${file} missing`); }
}

const tests = spawnSync(process.execPath, ["--test", "supervisor/dist/test/messaging.test.js", "supervisor/dist/test/switchclient.test.js"], { encoding: "utf8" });
tests.status === 0 ? pass("multi-room configuration and WebSocket claim tests") : fail((tests.stderr || tests.stdout).slice(-1200));

try {
  const base = `http://127.0.0.1:${env.GATEWAY_HOST_PORT || "3100"}/gateway`;
  const login = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: env.GATEWAY_ADMIN_EMAIL, password: env.GATEWAY_ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`Gateway login ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const response = await fetch(`${base}/collaborations/types`, { headers: { cookie } });
  if (!response.ok) throw new Error(`bridge catalog ${response.status}`);
  const keys = new Set((await response.json()).map(item => item.key));
  for (const platform of ["slack", "discord", "teams", "telegram", "mattermost"]) {
    keys.has(platform) ? pass(`Dockerized Switch exposes ${platform} adapter`) : fail(`Dockerized Switch missing ${platform} adapter`);
  }
} catch (error) {
  fail(`live messaging-adapter check: ${String(error)}`);
}

const tracked = spawnSync("git", ["grep", "-E", "xoxb-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}", "--", ":!package-lock.json"], { encoding: "utf8" });
tracked.status === 1 ? pass("no Slack tokens in tracked files") : fail("tracked files contain a Slack-shaped token");

if (!ok) process.exit(1);
console.log("messaging integration checks complete");
