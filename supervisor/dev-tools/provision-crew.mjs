// Provisioner: stands up the Night Shift crew from
// crew/nightshift.template.yaml.
//
//   node supervisor/dev-tools/provision-crew.mjs [--overwrite-agents]
//
// What it does on the headless 0.31.0 deployment:
//  1. reads the template's agent blocks (team prefix applied),
//  2. registers those agents via `POST /agents` with the admin-created
//     registration token, so the crew is owned by the admin account,
//  3. stores each agent's api_key in ops/.agents/<name>.key (chmod 600),
//  4. applies addressing policies via the Gateway (agent self-setting
//     refuses on this server build; owner/Gateway is the path),
//  5. submits the template's room block to the Gateway's
//     `POST /rooms/from-yaml` (the Console import equivalent the Gateway
//     already exposes), which creates the bridged room and posts the
//     kickoff on behalf of the deployer.
//
// Prints no secret, ever. Rather than a YAML library, the room block is
// extracted with line slicing — the template is this repo's own file with a
// fixed shape, and verify.sh checks the template keys.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const argv = new Set(process.argv.slice(2));
const OVERWRITE = argv.has("--overwrite-agents");

const env = Object.fromEntries(
  readFileSync(`${ROOT}ops/.env`, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l) && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const API = `http://127.0.0.1:${env.API_HOST_PORT ?? 8000}`;
const GW = `http://127.0.0.1:${env.GATEWAY_HOST_PORT ?? 3100}/gateway`;
const TEAM = env.CREW_TEAM ?? "nightshift";
const log = (...a) => console.log(new Date().toISOString(), "P1", ...a);
const strip = (b) => JSON.stringify(b).replace(/"[^"]{24,}"/g, '"<redacted>"');

// ---- template parsing (no YAML lib; this file's fixed shape) ------------

const templateText = readFileSync(`${ROOT}crew/nightshift.template.yaml`, "utf8");

function applyTeam(text, team) {
  return text.replaceAll("{team}", team);
}

function extractYamlSection(text, section) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^${section}:(\\s*\\|)?\\s*$`).test(l),
  );
  if (start === -1) throw new Error(`template has no ${section}: section`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z][A-Za-z-]*:/.test(lines[i])) break;
    if (lines[i].startsWith("version:")) break;
    out.push(lines[i]);
  }
  return out;
}

function leadingBlankTrim(lines) {
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[at0(lines)].trim() === "") lines.pop();
  return lines;
}
const at0 = (lines) => lines.length - 1;

// ---- gateway admin session ----------------------------------------------

async function gatewayLogin() {
  const r = await fetch(`${GW}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: env.GATEWAY_ADMIN_EMAIL,
      password: env.GATEWAY_ADMIN_PASSWORD,
    }),
  });
  if (!r.ok) throw new Error(`gateway login ${r.status}`);
  return r.headers
    .get("set-cookie")
    .split(";")
    .find((c) => c.trim().startsWith("switch_auth="));
}

const gatehead = (cookie, extra = {}) => ({
  cookie,
  "content-type": "application/json",
  ...extra,
});

// ---- agents --------------------------------------------------------------

const MANAGEABLE_POLICY = {
  rules: [
    {
      rooms: "*",
      room_groups: "*",
      users: [],
      agents: "*",
      owner: true,
      owner_agents: true,
      platform: true,
    },
  ],
};

const desiredAgents = [
  {
    name: `${TEAM}-night-lead`,
    description: "Turns the goal into strictly scoped taskslips, narrates assignments",
    profile: {
      connection_model: "always_on",
      message_exchange: true,
      pre_invocation_mediation: [],
      post_invocation_mediation: [],
      event_reporting: [],
    },
    policy: null, // anyone (open to the human)
  },
  {
    name: `${TEAM}-worker-1`,
    description: "Takes a taskslip, works it with the supervisor's spawner, files receipts",
    profile: {
      connection_model: "always_on",
      message_exchange: true,
      pre_invocation_mediation: [],
      post_invocation_mediation: [],
      event_reporting: [],
    },
    policy: MANAGEABLE_POLICY, // owner-agents
  },
  {
    name: `${TEAM}-worker-2`,
    description: "Takes a taskslip, works it with the supervisor's spawner, files receipts",
    profile: {
      connection_model: "always_on",
      message_exchange: true,
      pre_invocation_mediation: [],
      post_invocation_mediation: [],
      event_reporting: [],
    },
    policy: MANAGEABLE_POLICY, // owner-agents
  },
];

const AGENTS = [];

async function gatewayAgents() {
  const r = await fetch(`${GW}/agents`, { headers: { cookie: cookie } });
  if (!r.ok) throw new Error(`gateway agents ${r.status}`);
  const data = await r.json();
  return data.agents ?? data.items ?? data;
}

let cookie = await gatewayLogin();

for (const a of desiredAgents) {
  mkdirSync(`${ROOT}ops/.agents`, { recursive: true });
  const keyPath = `${ROOT}ops/.agents/${a.name}.key`;
  if (!OVERWRITE && existsSync(keyPath)) {
    const id = readFileSync(`${ROOT}ops/.agents/${a.name}.id`, "utf8").trim();
    log("agent exists (credentials kept):", a.name, id);
    AGENTS.push({ name: a.name, id });
    continue;
  }
  const send = (body) =>
    fetch(`${API}/agents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ADMIN_REGISTRATION_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  let res = await send({
    name: a.name,
    description: a.description,
    connector_type: "nightshift-crew",
    integration_profile: a.profile,
  });
  if (res.status === 409) {
    res = await send({
      name: a.name,
      description: a.description,
      connector_type: "nightshift-crew",
      integration_profile: a.profile,
      overwrite: true,
    });
  }
  if (!res.ok) {
    console.error(strip(await res.json().catch(() => ({}))));
    process.exit(1);
  }
  const reg = await res.json();
  writeFileSync(keyPath, `${reg.api_key}\n`, { mode: 0o600 });
  writeFileSync(`${ROOT}ops/.agents/${a.name}.id`, `${reg.id}\n`, { mode: 0o600 });
  log("registered agent", a.name, reg.id, "(api key stored, chmod 600)");
  AGENTS.push({ name: a.name, id: reg.id });
}

// addressing via the gateway (owner path on this build)
for (const { name, id } of AGENTS) {
  const a = desiredAgents.find((x) => x.name === name);
  const r = await fetch(`${GW}/agents/${id}/addressing-policy`, {
    method: "PUT",
    headers: gatehead(cookie),
    body: JSON.stringify({ policy: a.policy }),
  });
  if (!r.ok) {
    const t = await r.clone().text().catch(() => "");
    console.error(`addressing-policy ${name} ${r.status}: ${t.slice(0, 300)}`);
    process.exit(1);
  }
  log("addressing set for", name, a.policy === null ? "anyone" : "owner-agents");
}

// ---- room, from the template's room block --------------------------------
// Submit exactly the room section of the template (team-substituted, the
// bridge line dropped so the server uses its default bridge), plus the
// kickoff so the gateway posts it on behalf of the deployer.

const teamText = applyTeam(templateText, TEAM);
const roomLines = extractYamlSection(teamText, "room")
  .filter((l) => !/^ {2}bridge:/i.test(l));
const kickoffLines = extractYamlSection(teamText, "kickoff").filter(
  (l) => l.trim() !== "",
);
const roomYaml = [
  "version: 1",
  "",
  "room:",
  ...roomLines,
  "",
  "kickoff: |",
  ...kickoffLines,
  "",
].join("\n");

log("room submission YAML (verbatim, secrets none):");
log(roomYaml.split("\n").map((l) => `  | ${l}`).join("\n"));

const statePath = `${ROOT}ops/.agents/crew-state.json`;
if (existsSync(statePath) && !argv.has("--force-room")) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  log("room already provisioned (state kept):", state.room.name, state.room.id);
  console.log(
    JSON.stringify({ room: state.room, agents: state.agents.map((a) => a.name) }),
  );
  process.exit(0);
}

const rRoom = await fetch(`${GW}/rooms/from-yaml`, {
  method: "POST",
  headers: gatehead(cookie, { "content-type": "application/x-yaml" }),
  body: roomYaml,
});
const roomBody = await rRoom.json().catch(() => ({}));
if (!rRoom.ok) {
  console.error(`rooms/from-yaml ${rRoom.status}: ${JSON.stringify(roomBody).slice(0, 400)}`);
  process.exit(1);
}
log("room provisioned:", roomBody.room_name ?? roomBody.room_id, roomBody.room_id);

// Persist crew state for the supervisor and local verification.
writeFileSync(
  `${ROOT}ops/.agents/crew-state.json`,
  JSON.stringify(
    { team: TEAM, agents: AGENTS, room: { id: roomBody.room_id, name: roomBody.room_name } },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
log("crew-state saved to ops/.agents/crew-state.json");
