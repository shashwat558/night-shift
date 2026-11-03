// supervisor/src/goals.ts — the goal side of the night.
//
// Flow (SPEC §4.4 grammar + PHASE-PLAN 2.3):
//   human posts "tonight: …" (addressed) → supervisor nudges the night-lead
//   → watches crew/taskslips/<date>.yml → parses it with the strict parser
//   → hands slips to the orchestrator. The file is the machine truth; the
//   chat line from night-lead is narration.
//
// Watch contract ("2-phase timeout", PHASE-PLAN 2.3):
//   phase A — wait for the slips file to APPEAR (fs.watch recursive wake-up +
//             1s poll fallback), with its own deadline.
//   phase B — wait for the file to parse CLEANLY it may be written
//             incrementally): every change re-parses; if the parse still
//             fails at the deadline, return the exact errors so the
//             night-lead gets re-asked naming the gaps.
//   No file by the deadline → timeout (the supervisor blocks the night).
//
// Midnight: a goal at 23:58 may be decomped into the next day's date file —
// the watcher accepts <today>.yml OR <tomorrow>.yml for the goal's night.

import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { parseSlips, type Slip, type SlipsParse } from "./slips.js";

export const GOAL_PREFIX_RE = /^tonight:/i;

export function isGoal(body: string): boolean {
  return GOAL_PREFIX_RE.test(body.trim());
}

export function goalText(body: string): string {
  return body.trim().replace(GOAL_PREFIX_RE, "").trim();
}

export function slipsDir(repoRoot: string): string {
  return join(repoRoot, "crew", "taskslips");
}

/** The date-stamped file names this goal night may land in (local time). */
export function slipsFileCandidates(repoRoot: string, now = new Date()): string[] {
  const mk = (d: Date): string => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.yml`;
  };
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return [mk(now), mk(tomorrow)].map((name) => join(slipsDir(repoRoot), name));
}

export interface WatchResult {
  appeared: boolean;
  file: string | null;
  parse: SlipsParse | null;
  /** wall ms until the final state */
  elapsedMs: number;
}

export interface WatchOptions {
  phaseATimeoutMs?: number;
  phaseBTimeoutMs?: number;
  pollIntervalMs?: number;
  /** injectable clock for tests */
  now?: () => number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Watch the crew/taskslips dir with an fs.watch wake-up; the 1s poll is the
 * fallback if the dir does not exist yet or fs.watch fails (as on some fs).
 * Wake-ups only ever SHORTEN waits; every state decision still re-stats.
 */
async function pollWithWake(
  wakeDir: string,
  iterate: () => Promise<string | null>, // null = keep waiting
  deadline: number,
  waitMs: number,
  clock = Date.now,
): Promise<string | null> {
  let watcher: FSWatcher | null = null;
  const latch = { wake: (): void => {} };
  try {
    watcher = watch(wakeDir, { recursive: true }, () => latch.wake());
  } catch {
    watcher = null; // no dir / no watch support: the poll carries us
  }
  try {
    for (;;) {
      const result = await iterate();
      if (result !== null) return result;
      const now = clock();
      if (now >= deadline) return null;
      const remaining = Math.max(1, deadline - now);
      const gotWake = new Promise<void>((r) => {
        latch.wake = r;
      });
      await Promise.race([sleep(Math.min(waitMs, remaining)), gotWake]);
    }
  } finally {
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Wait for a slips file to appear and parse; strict-parser errors are
 * surfaced verbatim for the re-ask.
 */
export async function watchForSlips(
  repoRoot: string,
  opts: WatchOptions = {},
): Promise<WatchResult> {
  const phaseA = opts.phaseATimeoutMs ?? 45_000;
  const phaseB = opts.phaseBTimeoutMs ?? 45_000;
  const pollMs = opts.pollIntervalMs ?? 1_000;
  const clock = opts.now ?? Date.now;
  const start = clock();
  const dir = slipsDir(repoRoot);
  const candidates = slipsFileCandidates(repoRoot);

  const statFile = async (path: string): Promise<{ exists: boolean; mtimeMs: number; size: number }> => {
    try {
      const s = await fs.stat(path);
      return { exists: s.isFile(), mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return { exists: false, mtimeMs: 0, size: 0 };
    }
  };

  // ---- phase A: appear ------------------------------------------------------
  // wake on dir creation too: watch the crew/ parent when taskslips absent
  const watchDir = await fs.stat(dir).then(
    () => dir,
    () => join(repoRoot, "crew"),
  );
  const appearedPath = await pollWithWake(
    watchDir,
    async () => {
      for (const path of candidates) {
        if ((await statFile(path)).exists) return path;
      }
      return null;
    },
    start + phaseA,
    pollMs,
    clock,
  );

  if (!appearedPath) {
    return { appeared: false, file: null, parse: null, elapsedMs: clock() - start };
  }

  // ---- phase B: parse cleanly (file may be mid-write) ------------------------
  interface LastInfo {
    path: string;
    mtimeMs: number;
    size: number;
    parse: SlipsParse;
  }
  // a holder (not a bare let) so the pollWithWake closure can be traced
  const holder: { last: LastInfo | null } = { last: null };
  const parseResult = await pollWithWake(
    watchDir,
    async () => {
      const stat = await statFile(appearedPath as string);
      if (!stat.exists) return null;
      if (holder.last && holder.last.mtimeMs === stat.mtimeMs && holder.last.size === stat.size) {
        return holder.last.parse.ok ? "clean" : null; // unchanged and still dirty
      }
      const text = await fs.readFile(appearedPath as string, "utf8");
      const parse = parseSlips(text);
      holder.last = { path: appearedPath as string, mtimeMs: stat.mtimeMs, size: stat.size, parse };
      return parse.ok ? "clean" : null;
    },
    start + phaseA + phaseB,
    pollMs,
    clock,
  );
  void parseResult;

  return {
    appeared: true,
    file: holder.last?.path ?? appearedPath,
    parse: holder.last?.parse ?? { ok: false, errors: ["file did not become parseable before the deadline"] },
    elapsedMs: clock() - start,
  };
}

/** Parse one slips file directly (orchestrator re-uses the strict parser). */
export async function parseSlipsFile(path: string): Promise<SlipsParse> {
  try {
    const text = await fs.readFile(path, "utf8");
    return parseSlips(text);
  } catch (err) {
    return { ok: false, errors: [`cannot read ${path}: ${String(err).slice(0, 120)}`] };
  }
}

export type { Slip };
