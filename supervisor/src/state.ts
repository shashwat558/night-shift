// supervisor/src/state.ts — runtime state (cursor + ledger tail marker),
// persisted so a restart resumes instead of replaying a gap.
// Written into supervisor/.state.json (chmod 600, git-ignored), never logged.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUPERVISOR_DIR } from "./env.js";

export interface RuntimeState {
  /** Highest event sequence processed (the pong cursor). */
  cursor: number;
  /** The generation captured from the last connection_state. */
  generation: number | null;
}

function statePath(): string {
  return process.env.SUPERVISOR_STATE_PATH ?? join(SUPERVISOR_DIR, ".state.json");
}

export function readState(): RuntimeState {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<RuntimeState>;
    return {
      cursor: Number.isFinite(s.cursor) ? Math.max(0, s.cursor as number) : 0,
      generation: s.generation ?? null,
    };
  } catch {
    return { cursor: 0, generation: null };
  }
}

export function writeState(state: RuntimeState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state) + "\n", { mode: 0o600 });
  } catch {
    // state persistence is best-effort: losing it costs replay, never truth.
  }
}
