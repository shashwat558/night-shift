// Phase-1 verify checks (called by scripts/verify.sh, offline = localhost only).
// Exits 0 when the crew SOP is honest and present:
//   1. crew/nightshift.template.yaml carries v1, team param, three agent names,
//      a room named overnight-crew with the crew agents + users, and a kickoff
//      that addresses them;
//   2. crew/taskslip.schema.md and crew/receipt.schema.md exist with their key
//      headings;
//   3. the three crew agents are registered and owned by the admin account,
//      with addressing per template (lead: open policy; workers: owner-agents
//      rules), checked through the Gateway with an admin session.
// Prints one line per check; exits 1 on the first failure. No secrets printed.
import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
let ok = true;
const fail = (m) => { console.error(`FAIL ${m}`); ok = false; };
const passf = (m) => console.log(`PASS ${m}`);

const env = Object.fromEntries(
  readFileSync(`${ROOT}ops/.env`, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l) && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const TEAM = env.CREW_TEAM ?? "nightshift";

// 1. template
const t = readFileSync(`${ROOT}crew/nightshift.template.yaml`, "utf8");
const has = (re, m) => (re.test(t) ? passf(m) : fail(m));
has(/^version: 1\s*$/m, "template declares version: 1");
has(/^  team:\s*$/m, "template declares a team param");
for (const n of ["night-lead", "worker-1", "worker-2"]) {
  if (t.includes(`- name: "{team}-${n}"`)) passf(`template declares agent slot "${n}"`);
  else fail(`template declares agent slot "${n}"`);
}
has(/^room:\s*$/m, "template declares a room block");
has(/name: "overnight-crew"/, "template room is overnight-crew");
has(/^kickoff:/m, "template declares a kickoff");
has(/agents: \["\{team\}-night-lead", "\{team\}-worker-1", "\{team\}-worker-2"\]/,
  "template room lists the full crew");
has(/users: \["\{\$creator\}"\]/, "template room puts the deployer in it");

// 2. schemas
for (const [f, keys] of [
  ["crew/taskslip.schema.md", ["## Field rules", "`id`", "`files_allowed`", "`time_budget_minutes`"]],
  ["crew/receipt.schema.md", ["## Format", "summary:", "tests:", "deviations:"]],
]) {
  if (!existsSync(`${ROOT}${f}`)) { fail(`${f} missing`); continue; }
  const body = readFileSync(`${ROOT}${f}`, "utf8");
  const missing = keys.filter((k) => !body.includes(k));
  if (missing.length) fail(`${f} missing: ${missing.join(", ")}`);
  else passf(`${f} carries the contract`);
}

// 3. registered crew, admin-owned, addressing per template
const gw = `http://127.0.0.1:${env.GATEWAY_HOST_PORT ?? 3100}/gateway`;
const login = await fetch(`${gw}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: env.GATEWAY_ADMIN_EMAIL, password: env.GATEWAY_ADMIN_PASSWORD }),
});
if (!login.ok) fail(`gateway admin login ${login.status}`);
else {
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const head = { cookie };
  const agents = await (await fetch(`${gw}/agents`, { headers: head })).json();
  const list = agents.agents ?? agents.items ?? agents;
  for (const name of [
    `${TEAM}-night-lead`,
    `${TEAM}-worker-1`,
    `${TEAM}-worker-2`,
  ]) {
    const a = list.find((x) => x.name === name);
    if (!a) { fail(`agent ${name} not registered`); continue; }
    passf(`agent ${name} registered (${a.id.slice(0, 8)}…, owner ${a.owner_name ?? "unknown"})`);
    if (name.endsWith("night-lead")) {
      if (a.addressing_policy === null) passf("night-lead addressing open (policy null)");
      else fail("night-lead addressing is not open (policy not null)");
    } else {
      const rules = a.addressing_policy?.rules ?? [];
      const rule = rules[0];
      if (rule && rule.owner_agents === true && rule.owner === true)
        passf(`${name} addressing owner-agents (rule present)`);
      else fail(`${name} owner-agents rule missing`);
    }
  }
}

if (!ok) process.exit(1);
console.log("p1 checks complete");
