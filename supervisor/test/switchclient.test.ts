// test/switchclient.test.ts — the connection lifecycle, proven with fake
// server frames: connection_state adoption, ping→pong cursor, addressed-only
// message dispatch, evicted-code policy (heartbeat_lapsed resumes with
// start_from+expected_generation; taken_over stops), refusal downgrade.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SwitchClient } from "../src/switchclient.js";
import { Listener, type AddressedMessage } from "../src/listener.js";
import { testConfig } from "../src/env.js";
import { FakeSwitchServer, type HarnessConnection } from "./ws-harness.js";

const servers: FakeSwitchServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as FakeSwitchServer).close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 4000, everyMs = 10): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await wait(everyMs);
  }
}

async function firstConn(srv: FakeSwitchServer, ms = 3000): Promise<HarnessConnection> {
  await until(() => srv.connections.length > 0, ms);
  return srv.connections[0] as HarnessConnection;
}

const ROOM = "00000000-0000-0000-0000-000000000000";
const ROOM_TWO = "11111111-1111-1111-1111-111111111111";

function statePath(): string {
  process.env.SUPERVISOR_STATE_PATH = `/tmp/opencode/nightshift-test-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  return process.env.SUPERVISOR_STATE_PATH;
}

/** connection_state frame (docs: always the first frame on a connection). */
function connState(generation: number, cursor: number): string {
  return JSON.stringify({
    type: "connection_state",
    connection_id: "con-1",
    agent_id: "agent-1",
    generation,
    scope: "all",
    filter: "all",
    spawn_capable: false,
    rooms: [ROOM],
    cursor,
    protocol: 7,
    heartbeat_interval_seconds: 2,
    server: { version: "test" },
  });
}

function domainEvent(seq: number, sender: string, body: string, addressed: boolean): string {
  return JSON.stringify({
    event: "message",
    data: {
      type: "message",
      room_id: ROOM,
      bridge_id: "bridge-1",
      channel_type: "channel_private",
      payload: { sender, body, addressed },
      sequence: seq,
    },
    id: seq,
  });
}

function evicted(code: string, reason = ""): string {
  return JSON.stringify({ type: "evicted", code, reason });
}

test("declares every configured Switch room on the WebSocket", async (t) => {
  statePath();
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();
  const client = new SwitchClient(
    testConfig({
      apiBase: `http://127.0.0.1:${port}`,
      agentId: "agent-1",
      agentKey: "key-1",
      roomId: ROOM,
      roomIds: [ROOM, ROOM_TWO],
    }),
    {},
  );
  client.start();
  const conn = await firstConn(srv);
  assert.equal(conn.url.searchParams.get("rooms"), `${ROOM},${ROOM_TWO}`);
  client.stop();
});

test("connection_state adopted; pongs carry cursor; only addressed messages dispatch", async (t) => {
  statePath();
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const addressed: AddressedMessage[] = [];
  const nonAddressed: { sender: string; body: string }[] = [];
  const fatal: string[] = [];

  const listener = new Listener({
    onAddressed: (m) => addressed.push(m),
    onNonAddressed: (m) => nonAddressed.push({ sender: m.sender, body: m.body }),
  });
  const client = new SwitchClient(
    testConfig({ apiBase: `http://127.0.0.1:${port}`, agentId: "agent-1", agentKey: "key-1", roomId: ROOM }),
    {
      onDomain: (data, seq) => listener.handleDomain(data, seq),
      onFatal: (reason) => fatal.push(reason),
    },
  );
  client.start();

  const conn = await firstConn(srv);
  conn.sendRawFrame(1, Buffer.from(connState(7, 0)));
  await until(() => client.generation === 7);

  const pingLoop = setInterval(() => conn.sendPing(), 20);
  t.after(() => clearInterval(pingLoop));

  conn.sendRawFrame(1, Buffer.from(domainEvent(11, "@switch-mattermost-b-user:localhost", "tonight: do the thing", false)));
  conn.sendRawFrame(1, Buffer.from(domainEvent(12, "@switch-mattermost-b-user:localhost", "@shift-supervisor approve B-1", true)));
  conn.sendRawFrame(1, Buffer.from(domainEvent(13, "@nightshift-worker-1", "ack: take B-1", true)));

  await until(() => addressed.length >= 2 && nonAddressed.length >= 1);
  assert.equal(addressed[0]?.isHuman, true, "user-class sender detected");
  assert.equal(addressed[0]?.mentions.includes("@shift-supervisor"), true);
  assert.equal(nonAddressed[0]?.body, "tonight: do the thing", "delivered-but-not-acted flows through");
  assert.equal(addressed[1]?.isHuman, false, "agent-class sender detected");

  await until(() => conn.clientFrames.some((f) => f.opcode === 10), 2000);
  const pong = conn.clientFrames.find((f) => f.opcode === 10);
  assert.ok(pong, "client ponged the pings");
  assert.equal(JSON.parse(pong?.payload ?? "{}").cursor, 13, "pong carries the processed cursor");
  assert.equal(conn.maskViolation, false);
  assert.deepEqual(fatal, []);
  client.stop();
});

test("heartbeat_lapsed → reconnect carries start_from + expected_generation + same connection_id", async (t) => {
  statePath();
  const srv = new FakeSwitchServer({
    onConnection: (c) => {
      setImmediate(() => c.sendRawFrame(1, Buffer.from(connState(7, 0))));
      setTimeout(() => c.sendRawFrame(1, Buffer.from(evicted("heartbeat_lapsed"))), 150);
    },
  });
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const client = new SwitchClient(
    testConfig({ apiBase: `http://127.0.0.1:${port}`, agentId: "agent-1", agentKey: "k", roomId: ROOM }),
    {},
  );
  client.start();

  await until(() => srv.opens.length >= 2);
  const first = srv.opens[0] as URL;
  const second = srv.opens[1] as URL;
  assert.equal(first.searchParams.get("start_from"), "head", "first open starts at head");
  assert.equal(first.searchParams.get("expected_generation"), null, "no generation before a connection_state");
  assert.equal(second.searchParams.get("start_from"), "0", "resume: cursor 0 after connection_state echo");
  assert.equal(second.searchParams.get("expected_generation"), "7", "generation kept for the take-back guarantee");
  assert.equal(
    second.searchParams.get("connection_id"),
    first.searchParams.get("connection_id"),
    "same connection id is reused on every reconnect (docs requirement)",
  );
  client.stop();
});

test("cursor advances persist: resume start_from equals the processed sequence", async (t) => {
  statePath();
  const srv = new FakeSwitchServer({
    onConnection: (c) => {
      setImmediate(() => c.sendRawFrame(1, Buffer.from(connState(3, 0))));
      if (srv.opens.length === 1) {
        setTimeout(() => {
          c.sendRawFrame(1, Buffer.from(domainEvent(500, "@user:1", "hi", true)));
          setTimeout(() => c.sendRawFrame(1, Buffer.from(evicted("connection_error"))), 80);
        }, 50);
      }
    },
  });
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const client = new SwitchClient(
    testConfig({ apiBase: `http://127.0.0.1:${port}`, agentId: "agent-1", agentKey: "k", roomId: ROOM }),
    {},
  );
  client.start();

  await until(() => srv.opens.length >= 2);
  const resume = srv.opens[1] as URL;
  assert.equal(resume.searchParams.get("start_from"), "500", "resume from the processed sequence");
  assert.equal(resume.searchParams.get("expected_generation"), "3");
  client.stop();
});

test("taken_over evicts FINAL: no reconnect, onFatal fires", async (t) => {
  statePath();
  const srv = new FakeSwitchServer({
    onConnection: (c) => {
      setImmediate(() => c.sendRawFrame(1, Buffer.from(connState(9, 0))));
      setTimeout(() => c.sendRawFrame(1, Buffer.from(evicted("taken_over"))), 70);
    },
  });
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const fatal: string[] = [];
  const client = new SwitchClient(
    testConfig({ apiBase: `http://127.0.0.1:${port}`, agentId: "agent-1", agentKey: "k", roomId: ROOM }),
    { onFatal: (reason) => fatal.push(reason) },
  );
  client.start();
  await until(() => fatal.length >= 1);
  await wait(400);
  assert.equal(fatal[0], "taken_over");
  assert.equal(srv.opens.length, 1, "no reconnect after a takeover (final)");
  client.stop();
});

test("401 handshake halts with auth fatal (no spin)", async (t) => {
  statePath();
  const srv = new FakeSwitchServer({ refuseWith: 401 });
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const fatal: string[] = [];
  const client = new SwitchClient(
    testConfig({ apiBase: `http://127.0.0.1:${port}`, agentId: "agent-1", agentKey: "k", roomId: ROOM }),
    { onFatal: (reason) => fatal.push(reason) },
  );
  client.start();
  await until(() => fatal.length >= 1, 4000);
  await wait(600);
  assert.equal(fatal[0], "auth");
  assert.equal(srv.opens.length, 0, "no socket opened; refuse happened before upgrade");
  client.stop();
});

test("gap frame adopts resumed_at as the cursor", async (t) => {
  statePath();
  const srv = new FakeSwitchServer({
    onConnection: (c) => {
      setImmediate(() => c.sendRawFrame(1, Buffer.from(connState(5, 10))));
    },
  });
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const notes: string[] = [];
  const client = new SwitchClient(
    testConfig({ apiBase: `http://127.0.0.1:${port}`, agentId: "agent-1", agentKey: "k", roomId: ROOM }),
    { onConnection: (_up, detail) => notes.push(detail) },
  );
  client.start();
  const conn = await firstConn(srv);
  const stateLoop = setInterval(() => conn.sendPing(), 20);
  t.after(() => clearInterval(stateLoop));
  conn.sendRawFrame(
    1,
    Buffer.from(JSON.stringify({ type: "gap", from_sequence: 4, resumed_at: 33, resumed_position: 0, rooms: [ROOM], all_rooms: false, reason: "test" })),
  );
  await until(() => notes.some((n) => n.includes("gap from 4")));
  assert.equal(client.cursor, 33, "resumed_at taken as the new cursor");
  client.stop();
});

test("reconnect timer keeps an otherwise idle supervisor process alive", async (t) => {
  const { spawn } = await import("node:child_process");
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();
  const cfg = testConfig({ apiBase: `http://127.0.0.1:${port}`, agentId: "agent-1", agentKey: "test-key", roomId: ROOM });
  const moduleUrl = new URL("../src/switchclient.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { SwitchClient } from ${JSON.stringify(moduleUrl)}; new SwitchClient(${JSON.stringify(cfg)}, {}).start();`],
    { env: { ...process.env, SUPERVISOR_STATE_PATH: statePath() }, stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); });
  const conn = await firstConn(srv);
  conn.sendText(connState(1, 1));
  await wait(30);
  conn.destroy();
  await until(() => srv.connections.length >= 2, 6000);
  assert.equal(child.exitCode, null, "process must survive socket drop to perform reconnect");
});
