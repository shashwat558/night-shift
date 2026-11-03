// supervisor/src/listener.ts — turns domain frames into app-level events.
//
// Contract: act on a `message` event ONLY when payload.addressed is true
// (a connection is delivered everything in its rooms; acting is a separate
// decision). Sender classification follows the P0-proven shape: human posts
// arrive via the Mattermost bridge as
//   @switch-mattermost-<bridge-id>-<user>:localhost
// so a user-class sender is one whose id contains "-user:" — everything else
// is an agent (or the bridge itself posting as an agent persona).

import type { DomainData } from "./switchclient.js";

export interface AddressedMessage {
  /** Raw sender id (never printed with secrets — ids only). */
  sender: string;
  /** True when the sender is a human user (bridge puppet id contains -user:). */
  isHuman: boolean;
  /** The message body, whitespace-trimmed. */
  body: string;
  roomId: string | null;
  sequence: number;
  /** Mentioned handles inside the body, e.g. ["@shift-supervisor".] */
  mentions: string[];
}

export interface ListenerHandlers {
  onAddressed?: (m: AddressedMessage) => void;
  onNonAddressed?: (m: Omit<AddressedMessage, "mentions">) => void;
  /** Non-message domain events (command, room_join) — logged only. */
  onOtherDomain?: (type: string, sequence: number) => void;
}

export function isUserClassSender(sender: string | undefined): boolean {
  if (!sender) return false;
  return sender.includes("-user:");
}

export function extractMentions(body: string): string[] {
  const out = new Set<string>();
  for (const m of String(body).matchAll(/@([a-z0-9][a-z0-9._-]*)/g)) {
    if (m[1]) out.add(`@${m[1]}`);
  }
  return [...out];
}

export class Listener {
  constructor(private readonly handlers: ListenerHandlers) {}

  /** Feed domain frames here (already unwrapped by SwitchClient). */
  handleDomain(data: DomainData, sequence: number): void {
    if (data.type === "message") {
      const payload = (data.payload ?? {}) as Record<string, unknown>;
      const sender = typeof payload.sender === "string" ? payload.sender : "";
      const body = String(payload.body ?? "").trim();
      const base = {
        sender,
        isHuman: isUserClassSender(sender),
        body,
        roomId: data.room_id ?? null,
        sequence,
      };
      if (payload.addressed === true) {
        this.handlers.onAddressed?.({
          ...base,
          mentions: extractMentions(body),
        });
      } else {
        this.handlers.onNonAddressed?.(base);
      }
      return;
    }
    this.handlers.onOtherDomain?.(data.type, sequence);
  }
}
