// Phase-1 rehearsal runtime: one crew agent, template-driven.
//
//   node supervisor/dev-tools/crew-rehearsal.mjs nightshift-night-lead
//   node supervisor/dev-tools/crew-rehearsal.mjs nightshift-worker-1
//
// Behavior is read from crew/nightshift.template.yaml (persona + addressing).
// It listens on the SSE event stream (the compatibility path — the production
// supervisor gets the WebSocket transport in phase 2, see PROJECT_LOG phase 0
// delta 5), acts only on addressed messages, and ANSWERS WITH ITS OWN WORDS
// via `opencode run` (provider per decision D1), once per addressed message,
// capped. Workers additionally refuse user-class senders in-process (defense
// in depth on top of the server's `owner-agents` addressing policy).
//
// Prints no secret, ever.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;
const AGENT_NAME = process.argv[2];
if (!AGENT_NAME || !/^nightshift-/.test(AGENT_NAME)) {
  console.error("usage: crew-rehearsal.mjs <agent name: nightshift-...>");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(`${ROOT}ops/.env`, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l) && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const crewState = JSON.parse(readFileSync(`${ROOT}ops/.agents/crew-state.json`, "utf8"));
const API_KEY = readFileSync(`${ROOT}ops/.agents/${AGENT_NAME}.key`, "utf8").trim();
const AGENT_ID = readFileSync(`${ROOT}ops/.agents/${AGENT_NAME}.id`, "utf8").trim();
const API = `http://127.0.0.1:${env.API_HOST_PORT ?? 8000}`;
const ROOM_ID = crewState.room.id;
const ROOM_NAME = crewState.room.name;

// ---- the template text ---------------------------------------------------

const templateText = readFileSync(`${ROOT}crew/nightshift.template.yaml`, "utf8");
const team = crewState.team ?? "nightshift";

function section(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^${name}:(\\s*\\|)?\\s*$`).test(l),
  );
  if (start === -1) throw new Error(`template has no ${name}: section`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z][A-Za-z-]*:/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

// agents: entries start with "- name:"; each carries addressing + instructions
function agentEntries() {
  const block = section(templateText, "agents");
  const entries = [];
  let cur = null;
  for (const line of block) {
    if (/^  - name: /.test(line)) {
      const nm = line.slice(line.indexOf("name: ") + 6)
        .replaceAll("{team}", team).replace(/^"|"$/g, "").trim();
      if (cur) entries.push(cur);
      cur = { name: nm, addressing: null, instructions: [] };
    }
    if (!cur) continue;
    if (cur.name === null && /^\s+name: /.test(line)) {
      cur.name = line.split("name: ")[1].replaceAll("{team}", team).replace(/^"|"$/g, "");
    }
    if (cur.name === null) continue;
    if (/^\s+addressing: /.test(line)) cur.addressing = line.split("addressing: ")[1].replace(/^"|"$/g, "").trim();
    if (/^\s+instructions: \|\s*$/.test(line)) cur.inOpen = true;
    else if (cur.inOpen && /^\s{6}/.test(line)) cur.instructions.push(line.replace(/^ {6}/, ""));
    else if (cur.inOpen && !/^\s{6}/.test(line)) cur.inOpen = false;
  }
  if (cur) entries.push(cur);
  return entries;
}

const me = agentEntries().find((a) => a.name === AGENT_NAME);
if (!me) {
  console.error(`template has no agent ${AGENT_NAME}`);
  process.exit(2);
}
const OWNER_AGENTS_ONLY = me.addressing === "owner-agents";
const MAX_REPLIES = Number(env.P1_REHEARSAL_MAX_REPLIES ?? 3);
let replies = 0;
let saidCue = false;
const log = (...a) => console.log(new Date().toISOString(), AGENT_NAME, ...a);
log("template persona loaded (addressing:", me.addressing + ", max replies:", MAX_REPLIES + ")");

// ---- stream plumbing -----------------------------------------------------

const CONNECTION_ID = randomUUID();
let highest = 0;
let streamOk = false;

const headers = () => ({ authorization: `Bearer ${API_KEY}` });

const strip = (b) => String(b).replace(/("[^"]{30,}")/g, '"<redacted>"');

async function connectToRoom() {
  const r = await fetch(`${API}/agents/${AGENT_ID}/ops/connect_to_room`, {
    method: "POST",
    headers: { ...headers(), "x-switch-connection-id": CONNECTION_ID, "content-type": "application/json" },
    body: JSON.stringify({ room_id: ROOM_ID }),
  });
  const text = await r.clone().text();
  if (!r.ok) throw new Error(`connect_to_room ${r.status}: ${text.slice(0, 200)}`);
  log("connected to room", ROOM_NAME);
}

function askMyWords(contextLine, mode) {
  const modeText =
    mode === "cue"
      ? "Post ONE line addressed @nightshift-worker-1 and @nightshift-worker-2, waking them to introduce themselves in one line each. The line must mention both handles."
      : `Reply with exactly ONE line in the room (max 30 words).${OWNER_AGENTS_ONLY ? "" : ""}`;
  const prompt = [
    `You are "${me.name}" in an overnight crew chat room`,
    `Your job description: ${me.description}`,
    `Your standing instructions: ${me.instructions.join(" ")}`,
    `Latest room event you were addressed with: ${contextLine}`,
    modeText,
    "No lists, no markdown, no preamble — a single plain sentence as the agent itself would speak it.",
  ].join("\n");
  const res = spawnSync("opencode", ["run", prompt], { encoding: "utf8", timeout: 90_000 });
  if (res.error || res.status !== 0) {
    log("opencode failed:", res.error?.message ?? `exit ${res.status}`, strip(res.stderr ?? "").slice(0, 200));
    return null;
  }
  const out = String(res.stdout)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return out[0] ?? null;
}

async function postMessage(content) {
  const r = await fetch(`${API}/agents/${AGENT_ID}/message`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ room_id: ROOM_ID, content }),
  });
  if (!r.ok) {
    const t = await r.clone().text();
    log(`post failed ${r.status}: ${t.slice(0, 160)}`);
    return false;
  }
  log("posted:", JSON.stringify(content));
  return true;
}

function onFrame(payloadText) {
  let frame;
  try {
    frame = JSON.parse(payloadText);
  } catch {
    return;
  }
  const data = frame.data ?? frame;
  if (data?.type !== "message") return;
  const p = data.payload ?? {};
  const sender = p.sender ?? "";
  const body = String(p.body ?? "").replace(/\s+/g, " ").trim();
  const isUserClass = /-user:/.test(sender);
  log(
    "message",
    p.addressed ? "ADDRESSED" : "not-addressed",
    `from ${sender}`,
    "userclass=" + isUserClass,
    ":",
    body.slice(0, 100),
  );
  if (!p.addressed) return;
  if (OWNER_AGENTS_ONLY && isUserClass) {
    log("owner-agents policy: user-class sender ignored (workers stay silent)");
    return;
  }
  if (replies >= MAX_REPLIES) {
    log("reply cap reached; staying silent");
    return;
  }
  replies += 1;
  const words = askMyWords(body.slice(0, 400), "reply");
  if (!words) {
    replies -= 1;
    return;
  }
  postMessage(words).then(() => {
    if (!OWNER_AGENTS_ONLY && !saidCue && AGENT_NAME.endsWith("night-lead")) {
      saidCue = true;
      setTimeout(async () => {
        const cue = askMyWords("Kickoff done; wake the crew", "cue");
        if (cue) await postMessage(cue);
      }, 2500);
    }
  });
}

async function openStream() {
  const url = `${API}/agents/${AGENT_ID}/events?connection_id=${CONNECTION_ID}&scope=all&filter=all&start_from=head`;
  const r = await fetch(url, { headers: { ...headers(), accept: "text/event-stream" } });
  if (!r.ok) {
    const t = await r.clone().text().catch(() => "");
    throw new Error(`events stream ${r.status}: ${t.slice(0, 200)}`);
  }
  log("event stream open");
  streamOk = true;
  const drain = (async () => {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) onFrame(payload);
        } else if (line.startsWith("id:")) {
          const seq = Number.parseInt(line.slice(3).trim(), 10);
          if (Number.isFinite(seq)) highest = Math.max(highest, seq);
        }
      }
    }
    log("stream ended; reopening in 1s …");
    streamOk = false;
    setTimeout(() => openStream().catch((e) => log("reopen error:", String(e).slice(0, 160))), 1000);
  })();
  void drain;
}

setInterval(async () => {
  if (!streamOk) return;
  const r = await fetch(`${API}/agents/${AGENT_ID}/connection/beat`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ connection_id: CONNECTION_ID, cursor: highest }),
  }).catch(() => null);
  if (r?.status === 409) {
    const body = await r.json().catch(() => ({}));
    log("beat 409", body?.code ?? "");
    if (body?.code === "taken_over") process.exit(2);
    streamOk = false;
  }
}, 2000);

await openStream().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
await connectToRoom().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
log("listening for addressed messages …");
setInterval(() => {}, 60_000);
