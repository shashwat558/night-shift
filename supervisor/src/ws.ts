// supervisor/src/ws.ts — a dependency-free RFC 6455 WebSocket CLIENT over
// node:http/https's `upgrade` event.
//
// WHY hand-rolled: Node's built-in WebSocket (undici) cannot attach custom
// headers, and the Switch agent protocol authenticates the socket with
// `Authorization: Bearer <agent key>`.
//
// Contract notes (docs.switchagents.ai — agent connection):
//  - the client answers pings with pongs carrying the read cursor
//  - pongs must go out BEFORE events are dispatched: this pump parses a whole
//    TCP chunk first (answering pings inline as control frames are decoded),
//    then flushes the chunk's completed text messages in arrival order
//  - opening another socket with the same connection_id is a takeover → an
//    `evicted {code:"taken_over"}` frame arrives and the socket closes
//
// Server frames are unmasked; client frames are always masked (RFC 6455).

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import type { IncomingMessage } from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WsHandlers {
  open?: () => void;
  /** Completed text messages, flushed after each TCP chunk is fully parsed. */
  text?: (text: string) => void;
  /** Server ping. The handler must answer synchronously via sendPong. */
  ping?: (payload: Buffer) => void;
  close?: (code: number, reason: string) => void;
  error?: (err: Error) => void;
  /** Non-101 HTTP reply at open (e.g. wrong base or bad key). */
  refused?: (status: number, body: string) => void;
}

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  bytesConsumed: number;
}

export interface WsOptions {
  /**
   * Supplies the cursor pong for empty pings, inline before event dispatch.
   * Non-empty pings always echo their bytes for the RFC keepalive check.
   */
  pongPayload?: () => Buffer | string;
}

export class WsClient {
  private socket: Socket | null = null;
  private chunk: Buffer = Buffer.alloc(0);
  /** Fragmented-message assembly (bytes so far). */
  private fragment: Buffer | null = null;
  /** Completed text messages awaiting dispatch (ordering contract above). */
  private pendingTexts: string[] = [];
  private flushQueued = false;
  private closedByUs = false;
  private gotCloseFrame = false;
  private closeCode = 1005;
  private closeReason = "";
  private dead = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly handlers: WsHandlers,
    private readonly opts: WsOptions = {},
  ) {}

  /** Open the socket. Outcomes arrive through the handlers. */
  connect(): void {
    const u = new URL(this.url);
    // accept ws:// and wss:// and translate to the http(s) upgrade request
    if (u.protocol === "ws:") u.protocol = "http:";
    else if (u.protocol === "wss:") u.protocol = "https:";
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      this.handlers.error?.(new Error(`unsupported base protocol: ${u.protocol}`));
      return;
    }
    const isHttps = u.protocol === "https:";
    const key = randomBytes(16).toString("base64");
    const req = (isHttps ? httpsRequest : httpRequest)({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
        ...this.headers,
      },
    });

    req.on("upgrade", (res: IncomingMessage, socket: Socket, head: Buffer) => {
      const accept = res.headers["sec-websocket-accept"];
      const expect = createHash("sha1").update(key + WS_GUID).digest("base64");
      if (res.statusCode !== 101 || accept !== expect) {
        socket.destroy();
        this.handlers.error?.(
          new Error(`upgrade refused: status ${res.statusCode}, accept mismatch`),
        );
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on("data", (buf: Buffer) => this.onBytes(buf));
      socket.on("error", (err: Error) => {
        if (!this.closingWithCode()) this.handlers.error?.(err);
      });
      socket.on("close", () => this.onSocketClosed());
      this.handlers.open?.();
      if (head && head.length > 0) this.onBytes(head);
    });

    req.on("response", (res: IncomingMessage) => {
      // the server answered HTTP instead of upgrading (401/403/404/500 …)
      let body = "";
      res.on("data", (d: Buffer) => {
        body += d.toString("utf8");
      });
      res.on("end", () => {
        this.dead = true;
        this.handlers.refused?.(res.statusCode ?? 0, body.slice(0, 400));
      });
      res.resume();
    });

    req.on("error", (err: Error) => {
      if (!this.dead && !this.closingWithCode()) {
        this.dead = true;
        this.handlers.error?.(err);
        this.handlers.close?.(1006, String((err as Error).message ?? err));
      } else if (!this.dead) {
        this.dead = true;
        this.handlers.close?.(1006, String((err as Error).message ?? err));
      }
    });

    req.end();
  }

  get isOpen(): boolean {
    return this.socket != null && !this.dead && typeof this.socket.destroyed === "boolean" && !this.socket.destroyed;
  }

  /** Send one text message as a single masked FIN frame (clients MUST mask). */
  sendText(text: string): boolean {
    if (process.env.SUPERVISOR_WS_DEBUG === "1") {
      console.error(`[wsdebug] sendText len=${text.length} @${Date.now() % 100000}`);
    }
    return this.sendRaw(OP_TEXT, Buffer.from(text, "utf8"));
  }

  /**
   * Answer a ping. Payload per the Switch contract carries the cursor JSON;
   * RFC 6455 wants the ping payload echoed, size-capped at 125.
   */
  sendPong(payload: Buffer | string): boolean {
    const buf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    return this.sendRaw(OP_PONG, buf.subarray(0, 125));
  }

  sendPing(payload: Buffer | string = Buffer.alloc(0)): boolean {
    const buf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    return this.sendRaw(OP_PING, buf.subarray(0, 125));
  }

  /** Begin the closing handshake; force-destroy if the server dawdles. */
  close(code = 1000, reason = ""): void {
    if (this.closedByUs || this.dead) return;
    this.closedByUs = true;
    this.sendRaw(OP_CLOSE, closePayload(code, reason));
    if (this.socket) {
      this.socket.end();
      const t = setTimeout(() => this.socket?.destroy(), 2000);
      t.unref?.();
    }
  }

  private closingWithCode(): boolean {
    return this.closedByUs || this.gotCloseFrame;
  }

  private onSocketClosed(): void {
    if (this.dead) return;
    this.dead = true;
    const code = this.gotCloseFrame ? this.closeCode : 1006;
    this.handlers.close?.(code, this.closeReason);
  }

  // ---- frame sending (always masked — RFC 6455 client requirement) ---------

  private sendRaw(opcode: number, payload: Buffer): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || socket.writableEnded) return false;
    const len7 = payload.length > 65535 ? 127 : payload.length > 125 ? 126 : payload.length;
    const header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len7; // masked bit set for every client frame
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
    const key = randomBytes(4);
    parts.push(key, maskBuffer(payload, key));
    socket.write(Buffer.concat(parts));
    return true;
  }

  // ---- frame receiving ------------------------------------------------------

  private onBytes(buf: Buffer): void {
    if (this.dead) return;
    this.chunk = this.chunk.length > 0 ? Buffer.concat([this.chunk, buf]) : buf;
    for (;;) {
      const frame = tryParseFrame(this.chunk);
      if (frame === null) break; // need more bytes
      this.chunk = this.chunk.subarray(frame.bytesConsumed);
      this.handleFrame(frame);
      if (this.dead) return;
    }
    // whole chunk parsed → now events may dispatch (pings were answered inline)
    this.flushPendingTexts();
  }

  private handleFrame(frame: ParsedFrame): void {
    if (process.env.SUPERVISOR_WS_DEBUG === "1") {
      const op = frame.opcode === 0x9 ? "PING" : frame.opcode === 0xa ? "PONG" : frame.opcode === 0x8 ? "CLOSE" : frame.opcode === 0x1 ? "TEXT" : String(frame.opcode);
      console.error(`[wsdebug] recv op=${op} fin=${frame.fin} len=${frame.payload.length} @${Date.now() % 100000}`);
    }
    switch (frame.opcode) {
      case OP_TEXT: {
        if (frame.fin) {
          this.fragment = null;
          this.pendingTexts.push(frame.payload.toString("utf8"));
        } else {
          this.fragment = Buffer.from(frame.payload);
        }
        return;
      }
      case OP_CONT: {
        if (this.fragment !== null) {
          this.fragment = frame.fin
            ? Buffer.concat([this.fragment, frame.payload])
            : Buffer.concat([this.fragment, frame.payload]);
          if (frame.fin) {
            const text = this.fragment.toString("utf8");
            this.fragment = null;
            this.pendingTexts.push(text);
          }
        }
        return;
      }
      case OP_PING: {
        // answer immediately, inline, before any text dispatch of this chunk.
        // Empty payload ⇒ Switch wants the JSON pong with the cursor. A ping
        // carrying a payload (this build sends 4 bytes) must be ECHOed per
        // RFC 6455 — the server matches the pong on the ping's payload; a
        // JSON pong here is what trips its keepalive at +40s.
        let pong: Buffer;
        if (frame.payload.length === 0 && this.opts.pongPayload) {
          const custom = this.opts.pongPayload();
          const buf = typeof custom === "string" ? Buffer.from(custom, "utf8") : custom;
          pong = buf.length > 125 ? buf.subarray(0, 125) : buf;
        } else {
          pong = frame.payload.length > 125 ? frame.payload.subarray(0, 125) : frame.payload;
        }
        this.sendPong(pong);
        if (process.env.SUPERVISOR_WS_DEBUG === "1") {
          console.error(`[wsdebug] sent PONG (${pong.length} bytes) @${Date.now() % 100000}`);
        }
        this.handlers.ping?.(frame.payload);
        return;
      }
      case OP_PONG: {
        // nothing to do
        return;
      }
      case OP_CLOSE: {
        // a close handshake is one-shot: ignore duplicates (e.g. the echo of
        // our own echo) so the first code/reason stands
        if (this.gotCloseFrame) return;
        this.gotCloseFrame = true;
        let code = 1005;
        let reason = "";
        if (frame.payload.length >= 2) {
          code = frame.payload.readUInt16BE(0);
          reason = frame.payload.subarray(2).toString("utf8");
        }
        this.closeCode = code;
        this.closeReason = reason;
        if (!this.closedByUs) {
          this.sendRaw(OP_CLOSE, closePayload(code === 1005 ? 1000 : code, ""));
          if (this.socket) {
            this.socket.end();
            const t = setTimeout(() => this.socket?.destroy(), 2000);
            t.unref?.();
          }
        }
        return;
      }
      default: {
        // protocol error (unknown opcode)
        this.gotCloseFrame = true;
        this.closeCode = 1002;
        this.closeReason = `unknown opcode ${frame.opcode}`;
        this.sendRaw(OP_CLOSE, closePayload(1002, "protocol error"));
        if (this.socket) {
          this.socket.end();
          const t = setTimeout(() => this.socket?.destroy(), 1000);
          t.unref?.();
        }
        return;
      }
    }
  }

  private flushPendingTexts(): void {
    if (this.flushQueued || this.pendingTexts.length === 0) return;
    this.flushQueued = true;
    setImmediate(() => {
      this.flushQueued = false;
      const texts = this.pendingTexts;
      this.pendingTexts = [];
      for (const t of texts) {
        if (this.dead) return;
        this.handlers.text?.(t);
      }
    });
  }
}

/** Build a close-frame payload; 1006 has no wire representation. */
function closePayload(code: number, reason: string): Buffer {
  if (code === 1006) return Buffer.alloc(0);
  const reasonBuf = Buffer.from(reason.slice(0, 120), "utf8");
  const buf = Buffer.alloc(2 + reasonBuf.length);
  buf.writeUInt16BE(code, 0);
  reasonBuf.copy(buf, 2);
  return buf;
}

/** Parse one frame from the head of `buf`; null = need more bytes. */
function tryParseFrame(buf: Buffer): ParsedFrame | null {
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
    const big = buf.readBigUInt64BE(offset);
    if (big > 0xffffffffn) return null;
    len = Number(big);
    offset += 8;
  }
  if (masked) {
    // servers must not mask per RFC 6455; tolerate by consuming the key
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  return { fin, opcode, payload: Buffer.from(buf.subarray(offset, offset + len)), bytesConsumed: offset + len };
}

function maskBuffer(payload: Buffer, key: Buffer): Buffer {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) {
    (out[i] as number) ^= key[i % 4] as number;
  }
  return out;
}
