// supervisor/src/switchclient.ts — the agent-protocol connection lifecycle.
//
// Contract (docs.switchagents.ai — agent protocol + agent connection):
//  - WS at GET /agents/{id}/connection/ws?connection_id=<uuid>&rooms=<id>
//    (&scope=all&filter=all&start_from=…&expected_generation=… as needed)
//    authenticated by `Authorization: Bearer <agent key>` in the Upgrade
//    request (why a hand-rolled client: see ws.ts)
//  - server pings every 2s; answer each with {"type":"pong","cursor":N}
//    BEFORE processing events (ws.ts answers inline; ours supplies the cursor)
//  - open with start_from=head the first time; reconnects resume with
//    start_from=<cursor> + expected_generation=<generation kept from the last
//    connection_state>
//  - `evicted {code:"taken_over"}` → stop and DO NOT reconnect (takeover is
//    final); `heartbeat_lapsed`/`no_stream`/`unfenced`/`connection_error` →
//    reconnect and resume
//  - a `gap` frame means replay is incomplete: take resumed_at as the cursor
//  - act on `message` events only when payload.addressed (listener's job)
//  - HTTP ops: POST /agents/{id}/ops/{name} (+ x-switch-connection-id);
//    results arrive wrapped as {"result": …} on this server build (P0 delta)
//  - posting: POST /agents/{id}/message {room_id, content} needs no connection

import { readState, writeState, type RuntimeState } from "./state.js";
import type { Config } from "./env.js";
import { WsClient } from "./ws.js";

export interface DomainData {
  type: string;
  room_id?: string | null;
  bridge_id?: string | null;
  channel_type?: string | null;
  payload?: Record<string, unknown>;
  sequence?: number;
}

export interface ControlFrame {
  type: string;
  code?: string;
  reason?: string;
  detail?: string;
  status?: number;
  generation?: number;
  rooms?: string[];
  cursor?: number;
  protocol?: number;
  ["resumed_at"]?: number;
  from_sequence?: number;
  all_rooms?: boolean;
}

export interface Frame {
  event?: string;
  id?: number;
  data?: DomainData;
  /** control frames arrive flat */
  [k: string]: unknown;
}

export type FatalReason =
  | "taken_over"
  | "auth"
  | "repeated_refusal"
  | "stopped";

export interface SwitchClientHandlers {
  /** A domain frame (message/command/room_join). Dispatch happens AFTER the
   * pong for the chunk it arrived in has been written (ws.ts guarantee). */
  onDomain?: (data: DomainData, sequence: number) => void;
  /** The connection lifecycle, for logging + readiness. */
  onConnection?: (up: boolean, detail: string) => void;
  onFatal?: (reason: FatalReason, detail: string) => void;
}

const PING_WATCHDOG_MS = 8000; // pings come every 2s; 8s without = half-open
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15000;

export class SwitchClient {
  private ws: WsClient | null = null;
  private state: RuntimeState;
  private stopped = false;
  private lastPingAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private consecutiveRefusals = 0;
  private attempt = 0;
  /** Reconnect without a room claim after the server refuses the claim. */
  private claimDowngraded = false;

  constructor(
    private readonly cfg: Config,
    private readonly handlers: SwitchClientHandlers,
  ) {
    this.state = readState();
  }

  get cursor(): number {
    return this.state.cursor;
  }

  get generation(): number | null {
    return this.state.generation;
  }

  start(): void {
    this.stopped = false;
    this.openSocket();
    this.watchdog = setInterval(() => {
      if (this.stopped) return;
      if (this.ws?.isOpen && Date.now() - this.lastPingAt > PING_WATCHDOG_MS) {
        // half-open socket: no ping in 8s. Force a clean close; the close
        // event drives the resume path (same as a drop).
        this.ws.close(1000, "watchdog: no ping in 8s");
      }
    }, PING_WATCHDOG_MS / 2);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.ws?.close(1000, "supervisor stopping");
  }

  // ---- socket URL + lifecycle -----------------------------------------------

  private wsBase(): string {
    return this.cfg.apiBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  }

  private buildUrl(): string {
    const params = new URLSearchParams();
    params.set("connection_id", this.cfg.connectionId);
    if (!this.claimDowngraded && this.roomClaimId()) {
      params.set("rooms", this.roomClaimId() as string);
    }
    params.set("scope", "all");
    params.set("filter", "all");
    // first-ever open (no connection_state seen yet) → head; any later open
    // resumes from our cursor with the generation take-back guarantee.
    const resumed = this.state.generation != null;
    params.set("start_from", resumed ? String(this.state.cursor) : "head");
    if (resumed) params.set("expected_generation", String(this.state.generation as number));
    return `${this.wsBase()}/agents/${this.cfg.agentId}/connection/ws?${params.toString()}`;
  }

  roomClaimId(): string | null {
    return this.cfg.roomId;
  }

  private openSocket(): void {
    if (this.stopped) return;
    this.lastPingAt = Date.now();
    const url = this.buildUrl();
    const ws = new WsClient(
      url,
      { authorization: `Bearer ${this.cfg.agentKey}` },
      {
        open: () => {
          this.attempt = 0;
          this.handlers.onConnection?.(true, `connection open (${url.replace(/connection_id=[^&]+/, "connection_id=<uuid>")})`);
        },
        text: (text) => this.onFrameText(text),
        close: (code, reason) => this.onClosed(code, reason),
        error: (err) => this.handlers.onConnection?.(false, `socket error: ${err.message}`),
        refused: (status, body) => this.onRefused(status, body),
      },
      // If server sends an RFC ping (opcode 9) with an empty payload, answer with JSON pong
      {
        pongPayload: () => JSON.stringify({ type: "pong", cursor: this.cursor }),
      },
    );
    this.ws = ws;
    ws.connect();
  }

  private onRefused(status: number, body: string): void {
    if (this.stopped) return;
    if (status === 401 || status === 403) {
      this.handlers.onFatal?.("auth", `handshake refused with ${status}: ${body.slice(0, 120)}`);
      this.stopped = true;
      return;
    }
    this.consecutiveRefusals += 1;
    // a refusal can also mean the room claim was invalid (not a member):
    // downgrade the claim once before giving up.
    if (!this.claimDowngraded && !this.sawConnectionState) {
      this.claimDowngraded = true;
      this.handlers.onConnection?.(
        false,
        `open refused with ${status}; downgrading the room claim and retrying`,
      );
      this.scheduleReconnect(0);
      return;
    }
    if (this.consecutiveRefusals >= 3) {
      this.handlers.onFatal?.(
        "repeated_refusal",
        `connection refused ${this.consecutiveRefusals}× with ${status}: ${body.slice(0, 120)}`,
      );
      this.stopped = true;
      return;
    }
    this.scheduleReconnect(this.backoffMs());
  }

  private sawConnectionState = false;

  private onClosed(_code: number, reason: string): void {
    if (this.stopped) return;
    this.handlers.onConnection?.(false, `socket closed: ${reason || "no close frame"}`);
    if (!this.stopped) this.scheduleReconnect(this.backoffMs());
  }

  private scheduleReconnect(delay: number): void {
    if (this.stopped || this.reconnectTimer) return;
    // NOT unref'd: the reconnect is the process's lifeblood. While the socket
    // is down, every other handle is unref'd — a drain here would kill the
    // supervisor silently mid-night (found live on 2026-11-05).
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private backoffMs(): number {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    return base + Math.floor(Math.random() * 250);
  }

  // ---- frames ----------------------------------------------------------------

  private onFrameText(text: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      // garbage frame; the server ignores client noise, we ignore its binary junk
      return;
    }
    const type =
      typeof frame.event === "string"
        ? frame.event
        : typeof frame.type === "string"
          ? frame.type
          : typeof frame.data === "object" && frame.data !== null && typeof (frame.data as DomainData).type === "string"
            ? (frame.data as DomainData).type
            : "";

    if (type === "connection_state") {
      this.sawConnectionState = true;
      const c = (frame.data && typeof frame.data === "object" ? frame.data : frame) as unknown as ControlFrame;
      this.adoptConnectionState(c);
      return;
    }
    if (type === "ping") {
      this.lastPingAt = Date.now();
      // Server sends ping as an application text frame: {"event":"ping","data":{}}
      // Switch protocol expects a text frame pong with the cursor: {"type":"pong","cursor":N}
      if (this.ws?.isOpen) {
        this.ws.sendText(JSON.stringify({ type: "pong", cursor: this.cursor }));
      }
      return;
    }
    if (type === "evicted") {
      const ev = frame as unknown as ControlFrame;
      if (ev.code === "taken_over") {
        this.stopped = true;
        this.handlers.onConnection?.(false, "evicted: taken_over — another socket owns this connection id");
        this.handlers.onFatal?.("taken_over", "connection taken over; stopping (FINAL per docs)");
        return;
      }
      this.handlers.onConnection?.(
        false,
        `evicted: ${ev.code ?? "unknown"} (${ev.reason ?? ""}) — reconnecting with resume`,
      );
      if (!this.stopped) {
        if (this.ws) this.ws.close(1000, "reconnect after eviction");
        this.scheduleReconnect(0);
      }
      return;
    }
    if (type === "gap") {
      const gap = frame as unknown as ControlFrame;
      // docs win: take resumed_at as the new cursor (it may be lower than ours)
      if (typeof gap["resumed_at"] === "number") {
        this.state.cursor = gap["resumed_at"];
        writeState(this.state);
      }
      this.handlers.onConnection?.(
        false,
        `gap from ${gap.from_sequence ?? "?"}: re-read room history before responding`,
      );
      return;
    }
    if (type === "refused") {
      const refusedFrame = frame as unknown as ControlFrame;
      this.handlers.onConnection?.(
        false,
        `refused frame: ${refusedFrame.status ?? "?"} ${refusedFrame.detail ?? ""}`,
      );
      return;
    }
    if (type === "subscription_changed" || type === "room_released") {
      return; // informational on this single-room setup
    }

    // domain frames carry `event` + `data` + `id`
    if (typeof frame.event === "string" && frame.data && typeof frame.data === "object") {
      const seq = typeof frame.id === "number" ? frame.id : (frame.data.sequence ?? 0);
      this.handlers.onDomain?.(frame.data as DomainData, seq);
      // cursor = highest DISPATCHED sequence (bump only after the handler ran,
      // so a crash in between replays the event rather than losing it)
      this.bumpCursorTo(seq);
      return;
    }
    // unknown frame shapes are ignored silently on purpose (server may add)
  }

  private adoptConnectionState(c: ControlFrame): void {
    if (typeof c.generation === "number") this.state.generation = c.generation;
    if (typeof c.cursor === "number" && c.cursor > this.state.cursor) {
      this.state.cursor = c.cursor;
    }
    writeState(this.state);
    this.handlers.onConnection?.(
      true,
      `connection_state: generation ${c.generation ?? "?"}, rooms ${(c.rooms ?? []).join(",") || "none"}, cursor ${this.state.cursor}`,
    );
  }

  /** Cursor = highest sequence dispatched to the app. */
  private bumpCursorTo(seq: number): void {
    if (typeof seq !== "number" || seq <= this.state.cursor) return;
    this.state.cursor = seq;
    writeState(this.state);
  }

  // ---- HTTP side --------------------------------------------------------------

  async postMessage(roomId: string, content: string): Promise<boolean> {
    try {
      const r = await fetch(`${this.cfg.apiBase}/agents/${this.cfg.agentId}/message`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.agentKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ room_id: roomId, content }),
      });
      if (r.ok) return true;
      const body = await r.text().catch(() => "");
      this.handlers.onConnection?.(false, `post_message ${r.status}: ${body.slice(0, 160)}`);
      return false;
    } catch (err) {
      this.handlers.onConnection?.(false, `post_message failed: ${String(err).slice(0, 160)}`);
      return false;
    }
  }

  /** POST /agents/{id}/ops/{op}. Results unwrap from {"result": …} (P0 delta). */
  async op(opName: string, args: Record<string, unknown>): Promise<{ ok: boolean; status: number; result?: unknown; body?: string }> {
    try {
      const r = await fetch(`${this.cfg.apiBase}/agents/${this.cfg.agentId}/ops/${opName}`, {
        method: "POST",
        headers: {
          ...{
            authorization: `Bearer ${this.cfg.agentKey}`,
            "content-type": "application/json",
          },
          "x-switch-connection-id": this.cfg.connectionId,
        },
        body: JSON.stringify(args),
      });
      if (r.ok) {
        const body = (await r.json().catch(() => ({}))) as { result?: unknown };
        return { ok: true, status: r.status, result: body?.result };
      }
      return { ok: false, status: r.status, body: (await r.text().catch(() => "")).slice(0, 400) };
    } catch (err) {
      return { ok: false, status: 0, body: String(err).slice(0, 200) };
    }
  }
}
