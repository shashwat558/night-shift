// supervisor/src/exec.ts — one child-process helper for the supervisor's git,
// test runner, provider, and gh plumbing. Captures stdout+stderr, caps
// history, and supports the SIGKILL timeout.

import { spawn } from "node:child_process";

export interface ExecResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  error?: string;
  killed?: boolean;
}

const OUT_CAP = 400_000;

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function exec(cmd: string, args: string[], cwd: string, timeoutMs = 120_000, opts: ExecOptions = {}): Promise<ExecResult> {
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, output: "slip deadline cancelled", exitCode: null, killed: true });
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: opts.env ?? process.env, detached: true });
    let out = "";
    let err = "";
    const pushLine = (acc: string, d: Buffer, cap: number): string => ((acc + d.toString("utf8")).length > cap ? (acc + d.toString("utf8")).slice(-cap) : acc + d.toString("utf8"));
    child.stdout?.on("data", (d: Buffer) => {
      out = pushLine(out, d, OUT_CAP);
    });
    child.stderr?.on("data", (d: Buffer) => {
      err = pushLine(err, d, 100_000);
    });
    const kill = (): void => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
    opts.signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, timeoutMs);
    timer.unref?.();
    child.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve({ ok: false, output: (out + err).slice(-4000), exitCode: null, error: String(e) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve({
        ok: code === 0 && signal === null,
        output: (out + (err ? `\nSTDERR:\n${err}` : "")).slice(-8192),
        exitCode: code ?? null,
        ...(signal === "SIGKILL" ? { error: "killed: timeout", killed: true } : {}),
      });
    });
  });
}
