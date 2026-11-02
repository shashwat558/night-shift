// Ground-check client: proves an agent can be registered with the Switch
// server, join a bridged room, hear a human, and answer.
//
//   node supervisor/dev-tools/groundcheck.mjs
//
// Uses the SSE event stream (the compatibility path the v0.31.0 server still
// serves; the WebSocket path needs an Authorization header, which Node's
// built-in WebSocket cannot attach — recorded in PROJECT_LOG). Reads
// credentials from ops/.env. Prints no secrets, ever.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../../ops/.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l) && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const API = `http://127.0.0.1:${env.API_HOST_PORT ?? 8000}`;
// URL-quoted to survive chance spaces; never printed.
const API_KEY = Buffer.from(env.ADMIN_REGISTRATION_TOKEN).toString("hex");
const log = (...a) => console.log(new Date().toISOString(), "GC", ...a);
const strip = (b) => JSON.stringify(b).replace(/"[^"]{24,}"/g, '"<redacted>"');

const profile = {
  connection_model: "always_on",
  message_exchange: true,
  pre_invocation_mediation: [],
  post_invocation_mediation: [],
  event_reporting: [],
};

const send = (token, body) =>
  fetch(`${API}/agents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const regBody = () => ({
  name: "ground-check",
  description: "Phase 0 ground check: proves registration and room answering",
  connector_type: "ground-check",
  integration_profile: profile,
});

let res = await send(env.AGENT_REGISTRATION_TOKEN, regBody());
if (res.status === 409) {
  res = await send(env.AGENT_REGISTRATION_TOKEN, { ...regBody(), overwrite: true });
}
if (!res.ok) {
  console.error(strip(await res.json().catch(() => ({}))));
  process.exit(1);
}
const reg = await res.json();
const { id: AGENT, api_key: KEY } = reg;
log("registered agent", AGENT);

const headers = () => ({ authorization: `Bearer ${KEY}` });

const CONNECTION_ID = randomUUID();
let highest = 0;
let roomId = null;
let stream = null;
let streamOk = false;

async function createRoom() {
  const r = await fetch(`${API}/agents/${AGENT}/ops/create_room`, {
    method: "POST",
    headers: { ...headers(), "x-switch-connection-id": CONNECTION_ID, "content-type": "application/json" },
    body: JSON.stringify({
      name: "shift-hangar",
      description: "Night Shift phase 0 ground-check room",
      agent_names: ["ground-check"],
      user_names: ["user"],
      channel_type: "channel_private",
      instructions: "Phase 0 smoke room. A human will address ground-check.",
    }),
  });
  const body = await r.json().catch(() => ({}));
  const data = body?.result ?? body;
  if (!r.ok) throw new Error(`create_room ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  roomId = data?.room_id ?? data?.id ?? data?.room?.id;
  log("room created", roomId, data?.caller_is_member ? "(member)" : `failed=${data?.failed_attachments?.length ?? 0}`);
}

async function connectToRoom() {
  const r = await fetch(`${API}/agents/${AGENT}/ops/connect_to_room`, {
    method: "POST",
    headers: { ...headers(), "x-switch-connection-id": CONNECTION_ID, "content-type": "application/json" },
    body: JSON.stringify({ room_id: roomId }),
  });
  const text = await r.clone().text();
  if (!r.ok) throw new Error(`connect_to_room ${r.status}: ${text.slice(0, 300)}`);
  log("connected to room");
}

async function openStream() {
  const url = `${API}/agents/${AGENT}/events?connection_id=${CONNECTION_ID}&scope=all&filter=all&start_from=head`;
  const r = await fetch(url, {
    headers: { ...headers(), accept: "text/event-stream" },
  });
  if (!r.ok) {
    const t = await r.clone().text().catch(() => "");
    throw new Error(`events stream ${r.status}: ${t.slice(0, 200)}`);
  }
  log("event stream open");
  streamOk = true;
  // Stream is up; the room setup and the wait can proceed.
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
          if (!payload) continue;
          onFrame(payload);
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

function onFrame(payloadText) {
  let frame;
  try {
    frame = JSON.parse(payloadText);
  } catch {
    return;
  }
  const data = frame.data ?? frame;
  if (data.type === "message") {
    const p = data.payload ?? {};
    log(
      "message from",
      p.sender,
      p.addressed ? "ADDRESSED" : "not-addressed",
      ":",
      String(p.body ?? "").replace(/\n/g, " ").slice(0, 110),
    );
    if (p.addressed && String(p.body ?? "").includes("@ground-check") && roomId) {
      const content = "Night Shift ground check complete";
      fetch(`${API}/agents/${AGENT}/message`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ room_id: roomId, content }),
      })
        .then((r) => log(r.ok ? "posted:" : `post failed ${r.status}:`, r.ok ? content : ""))
        .catch((e) => log("post error", String(e).slice(0, 120)));
    }
  } else if (data.type) {
    log("frame", data.type);
  }
}

setInterval(async () => {
  if (!streamOk) return;
  const r = await fetch(`${API}/agents/${AGENT}/connection/beat`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ connection_id: CONNECTION_ID, cursor: highest }),
  }).catch(() => null);
  if (r?.status === 409) {
    const body = await r.json().catch(() => ({}));
    log("beat 409", body?.code ?? "");
    if (body?.code === "taken_over") process.exit(2);
    if (stream) try { await stream.cancel(); } catch {}
    streamOk = false;
  }
}, 2000);

await openStream().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
try {
  await createRoom();
  await connectToRoom();
} catch (e) {
  console.error(String(e));
  process.exit(1);
}
log("waiting for the human to address @ground-check …");
await new Promise(() => {});