// supervisor/test/ws-harness.ts — a minimal RFC 6455 SERVER for testing the
// hand-rolled client. Speaks real frames: unmasked server frames, masked
// client frames (verified), the Sec-WebSocket-Accept handshake, ping/pong/
// close opcodes, fragmentation, and abrupt TCP drops. No library — the point
// of the harness is to exercise the client's protocol knowledge directly.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export const TEST_OPCODES = { OP_CONT, OP_TEXT, OP_PING, OP_PONG, OP_CLOSE };

export interface ClientFrame {
  opcode: number;
  fin: boolean;
  masked: boolean;
  payload: string;
}

export interface HarnessConnection {
  url: URL;
  headers: Record<string, string>;
  /** every client frame received, in order */
  clientFrames: ClientFrame[];
  /** a client frame arrived UNMASKED: per RFC 6455 that is a violation */
  maskViolation: boolean;
  sendText: (s: string) => void;
  sendPing: (payload?: Buffer | string) => void;
  sendClose: (code: number, reason?: string) => void;
  /** text + continuations, with an optional pause between the pieces */
  sendFragmented: (parts: string[], delayMs?: number) => void;
  /** raw server frame send: connection_state, evicted, gap … as JSON text */
  sendRawFrame: (opcode: number, payload: Buffer, fin?: boolean) => void;
  destroy: () => void;
  end: () => void;
}

export interface HarnessServerOptions {
  /** reject the handshake entirely with a raw HTTP reply (e.g. 401) */
  refuseWith?: number;
  onConnection?: (conn: HarnessConnection) => void;
  onClientFrame?: (conn: HarnessConnection, frame: ClientFrame) => void;
  onClosed?: (conn: HarnessConnection) => void;
}

export class FakeSwitchServer {
  readonly server: Server;
  readonly connections: HarnessConnection[] = [];
  /** every accepted handshake URL, in order */
  readonly opens: URL[] = [];
  private opts: HarnessServerOptions;
  private socketsByConn = new Map<HarnessConnection, Socket>();

  constructor(opts: HarnessServerOptions = {}) {
    this.opts = opts;
    this.server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      socket.on("error", () => {});
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (this.opts.refuseWith) {
        const body = `HTTP/1.1 ${this.opts.refuseWith} Refused\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`;
        socket.end(body);
        return;
      }
      const key = req.headers["sec-websocket-key"];
      const upgrade = req.headers.upgrade;
      if (!key || String(upgrade).toLowerCase() !== "websocket") {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const accept = createHash("sha1").update(String(key) + WS_GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );

      const conn: HarnessConnection = {
        url,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        clientFrames: [],
        maskViolation: false,
        sendText: (s) => this.sendRaw(conn, OP_TEXT, Buffer.from(s, "utf8")),
        sendPing: (payload = Buffer.alloc(0)) =>
          this.sendRaw(conn, OP_PING, typeof payload === "string" ? Buffer.from(payload) : payload),
        sendClose: (code, reason = "") => {
          const reasonBuf = Buffer.from(reason, "utf8");
          const buf = Buffer.alloc(2 + reasonBuf.length);
          buf.writeUInt16BE(code, 0);
          reasonBuf.copy(buf, 2);
          this.sendRaw(conn, OP_CLOSE, buf);
        },
        sendFragmented: (parts, delayMs = 0) => this.sendRawFragmented(conn, parts, delayMs),
        sendRawFrame: (opcode, payload, fin = true) => this.sendRaw(conn, opcode, payload, fin),
        destroy: () => socket.destroy(),
        end: () => socket.end(),
      };
      this.opens.push(url);
      this.connections.push(conn);
      this.socketsByConn.set(conn, socket);

      let acc = Buffer.alloc(0);
      let fragment: Buffer | null = null;
      let fragmentOpcode = 0;
      socket.on("data", (buf: Buffer) => {
        acc = buf.length > 0 ? Buffer.concat([acc, buf]) : acc;
        const record = (opcode: number, payload: Buffer, fin: boolean, masked: boolean): void => {
          const cf: ClientFrame = { opcode, fin, masked, payload: payload.toString("utf8") };
          conn.clientFrames.push(cf);
          this.opts.onClientFrame?.(conn, cf);
        };
        for (;;) {
          const f = parseClientFrame(acc);
          if (!f) break;
          acc = acc.subarray(f.bytesConsumed);
          if (!f.masked) conn.maskViolation = true;
          if (f.opcode === OP_TEXT && f.fin) {
            fragment = null;
            record(OP_TEXT, f.payload, true, f.masked);
          } else if (f.opcode === OP_TEXT) {
            fragment = Buffer.from(f.payload);
            fragmentOpcode = f.opcode;
          } else if (f.opcode === OP_CONT) {
            if (fragment !== null) {
              fragment = Buffer.concat([fragment, f.payload]);
              if (f.fin) {
                const complete = fragment;
                fragment = null;
                record(fragmentOpcode, complete, true, f.masked);
              }
            }
          } else if (f.opcode === OP_PONG || f.opcode === OP_PING) {
            record(f.opcode, f.payload, f.fin, f.masked);
          } else if (f.opcode === OP_CLOSE) {
            record(OP_CLOSE, f.payload, f.fin, f.masked);
            const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
            const echo = Buffer.alloc(2);
            echo.writeUInt16BE(code === 1005 ? 1000 : code, 0);
            socket.write(frameBytes(OP_CLOSE, echo));
            socket.end();
            socket.on("close", () => this.opts.onClosed?.(conn));
            return;
          }
        }
      });
      if (head && head.length > 0) socket.emit("data", head);
      this.opts.onConnection?.(conn);
    });
  }

  private sendRaw(conn: HarnessConnection, opcode: number, payload: Buffer, fin = true): void {
    const socket = this.socketsByConn.get(conn);
    if (!socket || socket.destroyed) return;
    socket.write(frameBytes(opcode, payload, fin));
  }

  private sendRawFragmented(conn: HarnessConnection, parts: string[], delayMs = 0): void {
    const socket = this.socketsByConn.get(conn);
    if (!socket) return;
    const bufs = parts.map((p) => Buffer.from(p, "utf8"));
    const senders = bufs.map((payload, i) => ({
      opcode: i === 0 ? OP_TEXT : OP_CONT,
      payload,
      fin: i === bufs.length - 1, // only the final piece carries FIN
    }));
    let i = 0;
    const tick = (): void => {
      if (i >= senders.length || socket.destroyed) return;
      const { opcode, payload, fin } = senders[i] as { opcode: number; payload: Buffer; fin: boolean };
      socket.write(frameBytes(opcode, payload, fin));
      i += 1;
      if (i < senders.length) {
        if (delayMs > 0) setTimeout(tick, delayMs);
        else tick();
      }
    };
    tick();
  }

  /** The URL params of the last open, for resume assertions. */
  lastOpenParams(): URLSearchParams {
    return new URLSearchParams(this.opens[this.opens.length - 1]?.search ?? "");
  }

  async listen(host = "127.0.0.1", port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        const addr = this.server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.socketsByConn.values()) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function frameBytes(opcode: number, payload: Buffer, fin = true): Buffer {
  const len7 = payload.length > 65535 ? 127 : payload.length > 125 ? 126 : payload.length;
  const header = Buffer.alloc(2);
  header[0] = (fin ? 0x80 : 0) | opcode; // server frames unmasked; FIN param
  header[1] = len7;
  const parts: Buffer[] = [header];
  if (len7 === 126) {
    const ext = Buffer.alloc(2);
    ext.writeUInt16BE(payload.length, 0);
    parts.push(ext);
  } else if (len7 === 127) {
    const ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(payload.length), 0);
    parts.push(ext);
  }
  parts.push(payload);
  return Buffer.concat(parts);
}

interface ParsedClient {
  opcode: number;
  fin: boolean;
  masked: boolean;
  payload: Buffer;
  bytesConsumed: number;
}

/** Client frames MUST be masked; the harness parses + unmasks them. */
function parseClientFrame(buf: Buffer): ParsedClient | null {
  if (buf.length < 2) return null;
  const b0 = buf[0] as number;
  const b1 = buf[1] as number;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let maskKey: Buffer | null = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) {
      (payload[i] as number) ^= maskKey[i % 4] as number;
    }
  }
  return { opcode, fin, masked, payload, bytesConsumed: offset + len };
}
