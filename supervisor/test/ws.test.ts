// test/ws.test.ts — the hand-rolled RFC 6455 client, tested against a real
// frame-speaking fake server. Every claim about the wire lives here.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WsClient } from "../src/ws.js";
import { FakeSwitchServer, type HarnessConnection } from "./ws-harness.js";

const servers: FakeSwitchServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as FakeSwitchServer).close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until predicate is true, or throw after `ms`. */
async function until(pred: () => boolean, ms = 3000, everyMs = 10): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await wait(everyMs);
  }
}

/** Wait for the fake server's first accepted connection. */
async function firstConn(srv: FakeSwitchServer, ms = 3000): Promise<HarnessConnection> {
  await until(() => srv.connections.length > 0, ms);
  return srv.connections[0] as HarnessConnection;
}

test("opens the socket, carries the Authorization header, and speaks masked frames", async (t) => {
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const got: string[] = [];
  const client = new WsClient(
    `ws://127.0.0.1:${port}/agents/agent-test/connection/ws?connection_id=abc`,
    { authorization: "Bearer test-key-1234" },
    { text: (s) => got.push(s) },
  );
  client.connect();

  const conn = await firstConn(srv);
  assert.equal(conn.headers.authorization, "Bearer test-key-1234", "the bearer key rides the upgrade request");
  assert.match(conn.headers["sec-websocket-key"] ?? "", /.+/);

  // server → client text
  conn.sendText("hi from server");
  await until(() => got.includes("hi from server"));

  // client → server text must arrive masked, decodable
  assert.equal(client.sendText("hello back"), true);
  await until(() => conn.clientFrames.length > 0);
  const frame = conn.clientFrames[0] as { opcode: number; masked: boolean; payload: string };
  assert.equal(frame.opcode, 1);
  assert.equal(frame.masked, true, "client frames are masked per RFC 6455");
  assert.equal(frame.payload, "hello back");
  assert.equal(conn.maskViolation, false);
});

test("answers a ping before dispatching events from the same chunk", async (t) => {
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const lines: string[] = [];
  const client = new WsClient(
    `ws://127.0.0.1:${port}/x`,
    { authorization: "Bearer k" },
    {
      // the raw client echoes the ping payload (RFC semantics)
      ping: () => lines.push("ping-handled"),
      text: (s) => lines.push(`text:${s}`),
    },
  );
  client.connect();
  const conn = await firstConn(srv);

  conn.sendPing("beat-1");
  conn.sendText("event-one");
  await until(() => lines.includes("text:event-one"));

  // pong went out inline during parsing, BEFORE the text event dispatch
  const pong = conn.clientFrames.find((f) => f.opcode === 10);
  assert.ok(pong, "client sent a pong");
  assert.equal(pong?.payload, "beat-1", "raw client echoes the ping payload");
  assert.deepEqual(lines, ["ping-handled", "text:event-one"]);
  assert.equal(conn.maskViolation, false);
});

test("pongPayload option replaces the RFC echo with caller-supplied bytes", async (t) => {
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const client = new WsClient(
    `ws://127.0.0.1:${port}/x`,
    { authorization: "Bearer k" },
    { ping: () => {} },
    { pongPayload: () => JSON.stringify({ type: "pong", cursor: 42 }) },
  );
  client.connect();
  const conn = await firstConn(srv);
  conn.sendPing();
  await until(() => conn.clientFrames.some((f) => f.opcode === 10));
  const pong = conn.clientFrames.find((f) => f.opcode === 10) as { payload: string };
  assert.deepEqual(JSON.parse(pong.payload), { type: "pong", cursor: 42 });
  assert.equal(conn.maskViolation, false);
});

test("reassembles fragmented text messages", async (t) => {
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const got: string[] = [];
  new WsClient(`ws://127.0.0.1:${port}/x`, { authorization: "Bearer k" }, {
    text: (s) => got.push(s),
  }).connect();
  const conn = await firstConn(srv);
  conn.sendFragmented(["Hel", "lo", " world"]);
  await until(() => got.length === 1);
  assert.equal(got[0], "Hello world", "fragments arrive as ONE message");
});

test("close handshake: echoing close and reporting the code", async (t) => {
  let closedCode = 0;
  let closedReason = "";
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  new WsClient(`ws://127.0.0.1:${port}/x`, { authorization: "Bearer k" }, {
    close: (code, reason) => {
      closedCode = code;
      closedReason = reason;
    },
  }).connect();
  const conn = await firstConn(srv);
  conn.sendClose(1000, "server says bye");
  await until(() => closedCode !== 0);
  assert.equal(closedCode, 1000);
  assert.equal(closedReason, "server says bye");
  // client echoed the close
  const echo = conn.clientFrames.find((f) => f.opcode === 8);
  assert.ok(echo, "client echoed the close frame");
  assert.ok((echo as { payload: string }).payload.length >= 2);
});

test("abrupt server-side drop surfaces as code 1006", async (t) => {
  let closedCode = 0;
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  new WsClient(`ws://127.0.0.1:${port}/x`, { authorization: "Bearer k" }, {
    close: (code) => {
      closedCode = code;
    },
  }).connect();
  const conn = await firstConn(srv);
  conn.destroy();
  await until(() => closedCode !== 0);
  assert.equal(closedCode, 1006, "no close frame → abnormal closure");
});

test("messages larger than 64 KiB travel through the 127-length path", async (t) => {
  const srv = new FakeSwitchServer();
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const got: string[] = [];
  const client = new WsClient(`ws://127.0.0.1:${port}/x`, { authorization: "Bearer k" }, {
    text: (s) => got.push(s),
  });
  client.connect();
  const conn = await firstConn(srv);

  const big = "x".repeat(70000);
  assert.equal(client.sendText(big), true);
  await until(() => (conn.clientFrames[0]?.payload?.length ?? 0) === 70000);
  assert.equal((conn.clientFrames[0] as { payload: string }).payload, big);
  assert.equal((conn.clientFrames[0] as { masked: boolean }).masked, true);

  conn.sendText("y".repeat(130000));
  await until(() => (got[0]?.length ?? 0) === 130000);
  assert.equal((got[0] as string).length, 130000);
});

test("a plain HTTP refusal (no upgrade) reaches refused()", async (t) => {
  const srv = new FakeSwitchServer({ refuseWith: 401 });
  t.after(() => srv.close());
  servers.push(srv);
  const port = await srv.listen();

  const refused: number[] = [];
  new WsClient(`ws://127.0.0.1:${port}/x`, { authorization: "Bearer bad" }, {
    refused: (status) => refused.push(status),
  }).connect();
  await until(() => refused.length > 0);
  assert.equal(refused[0], 401);
});

test("a lying Sec-WebSocket-Accept is rejected before open", async (t) => {
  const { createServer } = await import("node:http");
  const srv = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  srv.on("upgrade", (_req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: BOGUSKEY\r\n\r\n",
    );
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  t.after(() => srv.close());

  const errors: string[] = [];
  let opened = false;
  new WsClient(`ws://127.0.0.1:${port}/x`, { authorization: "Bearer k" }, {
    open: () => {
      opened = true;
    },
    error: (e) => errors.push(e.message),
  }).connect();
  await wait(300);
  await until(() => errors.length > 0);
  assert.equal(opened, false, "client never opens on a bad accept key");
  assert.match(errors[0] as string, /accept mismatch/);
});
