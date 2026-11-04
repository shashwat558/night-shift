// supervisor/src/main.ts — the overnight orchestration loop (SPEC §2 + PHASE-PLAN 2.6).
//
// Flow:
//   1. Load config; start SwitchClient (WS + HTTP ops).
//   2. Listen for addressed "tonight: …" from a human — the goal.
//   3. Post an assignment narration to the room, nudge the night-lead worker
//      agent with the goal text (@nightshift-night-lead).
//   4. Watch crew/taskslips/<date>.yml for the night-lead's response (2-phase
//      timeout — goals.ts).  On timeout or parse error, re-post the exact
//      error so the night-lead can correct it.
//   5. For each slip: narrate the assignment, nudge the assigned worker agent,
//      run the headless coder (spawner.ts), push branch + open draft PR
//      (prs.ts), post the room summary with task id / branch / PR link /
//      PASS|FAIL, append a ledger.jsonl entry.
//   6. On SwitchClient fatal (taken_over): exit cleanly.
//
// Concurrency: slips run SEQUENTIALLY — a single target/ worktree cannot
// safely host two headless coders at once. Future phases can relax this if
// each worker gets its own worktree.
//
// Signals: SIGTERM / SIGINT → graceful stop (finish any running worker then
// exit). SIGTERM is re-raised after the cleanup window so the process manager
// can clean up without a SIGKILL.

import { readFileSync } from "node:fs";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile, loadConfig, SUPERVISOR_DIR, REPO_ROOT, type Config } from "./env.js";
import { SwitchClient } from "./switchclient.js";
import { Listener } from "./listener.js";
import type { AddressedMessage } from "./listener.js";
import { isGoal, goalText, watchForSlips } from "./goals.js";
import { runWorker } from "./spawner.js";
import {
  createDraftPr,
  parseProviderReceipt,
  renderReceipts,
  renderPrBody,
} from "./prs.js";
import type { Slip } from "./slips.js";

// ---- ledger ------------------------------------------------------------------

export interface LedgerEntry {
  ts: string;
  taskId: string;
  branch: string;
  prUrl: string | null;
  prNumber: number | null;
  testPass: boolean | null;
  blocked: boolean;
  reason?: string;
  summary: string;
  filesChanged: number;
  budgetMin: number;
  spentMin: number;
}

function ledgerPath(): string {
  return process.env.LEDGER_PATH ?? join(SUPERVISOR_DIR, "ledger.jsonl");
}

export function appendLedger(entry: LedgerEntry): void {
  try {
    appendFileSync(ledgerPath(), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // best-effort: a crash here must not kill the loop
  }
}

// ---- room post helpers -------------------------------------------------------

/** Worker ack nudge — posted to the room before the headless coder starts. */
export function assignmentNarration(slip: Slip, workerHandle: string): string {
  return (
    `@${workerHandle} — assignment **${slip.id}**: ${slip.title}\n` +
    `Branch: \`shift/${slip.id}\` · Budget: ${slip.time_budget_minutes} min\n` +
    `Scope: ${slip.scope}`
  );
}

/** Room post for a completed run — task id, branch, PR link, summary, PASS/FAIL. */
export function runSummaryPost(
  slip: Slip,
  prUrl: string | null,
  prNumber: number | null,
  testPass: boolean | null,
  blocked: boolean,
  reason: string | undefined,
  summary: string,
): string {
  const statusEmoji = blocked ? "🚫" : testPass ? "✅" : "⚠️";
  const status = blocked ? `BLOCKED — ${reason ?? "unknown"}` : testPass ? "PASS" : "FAIL";
  const prLine = prUrl ? `PR: [#${prNumber ?? "?"}](${prUrl}) (draft)` : "PR: not opened";
  return [
    `${statusEmoji} **${slip.id}** — ${slip.title}`,
    `Branch: \`shift/${slip.id}\` · ${prLine}`,
    `Tests: **${status}**`,
    summary !== slip.title ? `Summary: ${summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- goal re-ask on slip failure --------------------------------------------

function slipErrorPost(errors: string[]): string {
  return (
    `@${nightLeadHandle()} — the slips file has errors; please fix and re-save:\n` +
    errors.map((e) => `- ${e}`).join("\n")
  );
}

function nightLeadHandle(crewPrefix = "nightshift"): string {
  return `${crewPrefix}-night-lead`;
}

// ---- orchestration -----------------------------------------------------------

interface NightContext {
  cfg: Config;
  client: SwitchClient;
  roomId: string;
  busy: boolean;
}

/** Run one slip end-to-end: worker run → PR → room post → ledger. */
async function processSlip(ctx: NightContext, slip: Slip, log: (...a: unknown[]) => void): Promise<void> {
  const { cfg, client, roomId } = ctx;

  // 1. assignment narration + worker ack nudge
  const workerHandle = slip.assignee;
  const narration = assignmentNarration(slip, workerHandle);
  log(`[${slip.id}] posting assignment narration`);
  await client.postMessage(roomId, narration);

  // 2. run the headless coder
  log(`[${slip.id}] starting worker run (provider: ${cfg.provider})`);
  const wip = await runWorker(cfg, slip, log);

  // 3. push + PR (even on blocked — the branch may still have partial work)
  let prResult = { ok: false, prUrl: null as string | null, prNumber: null as number | null, output: "blocked before push" };
  if (!wip.blocked || wip.filesTouched.length > 0) {
    log(`[${slip.id}] opening draft PR`);
    prResult = await createDraftPr(cfg.targetDir, slip, wip, {
      provider: cfg.provider,
      ghRepo: cfg.ghRepo,
    });
    if (!prResult.ok) {
      log(`[${slip.id}] PR failed: ${prResult.output.slice(0, 200)}`);
    }
  }

  // 4. room post (task id, branch, PR link, summary, PASS/FAIL)
  const attempt = parseProviderReceipt(wip.providerOutput, slip.id);
  const summary = attempt.summary ?? slip.title;
  const roomPost = runSummaryPost(
    slip,
    prResult.prUrl,
    prResult.prNumber,
    wip.testPass,
    wip.blocked,
    "reason" in wip ? (wip as unknown as { reason?: string }).reason : undefined,
    summary,
  );
  log(`[${slip.id}] posting room summary`);
  await client.postMessage(roomId, roomPost);

  // 5. ledger append
  const startMs = wip.startedAt;
  const endMs = wip.finishedAt ?? Date.now();
  const spentMin = Math.max(1, Math.round((endMs - startMs) / 60_000));
  const entry: LedgerEntry = {
    ts: new Date(endMs).toISOString(),
    taskId: slip.id,
    branch: `shift/${slip.id}`,
    prUrl: prResult.prUrl,
    prNumber: prResult.prNumber,
    testPass: wip.testPass,
    blocked: wip.blocked,
    reason: "reason" in wip ? (wip as unknown as { reason?: string }).reason : undefined,
    summary,
    filesChanged: wip.filesTouched.length,
    budgetMin: slip.time_budget_minutes,
    spentMin,
  };
  appendLedger(entry);
  log(`[${slip.id}] done — ledger appended`);
}

/** Handle one goal message: watch for slips, then process them in sequence. */
async function handleGoal(ctx: NightContext, msg: AddressedMessage, log: (...a: unknown[]) => void): Promise<void> {
  const { cfg, client, roomId } = ctx;
  const goal = goalText(msg.body);
  log(`goal received from ${msg.sender}: "${goal.slice(0, 120)}"`);

  // nudge night-lead
  const leadHandle = nightLeadHandle(cfg.crewPrefix);
  const nudge =
    `@${leadHandle} — tonight's goal: **${goal}**\n` +
    `Please decompose into taskslips and write to crew/taskslips/<date>.yml.`;
  await client.postMessage(roomId, nudge);

  // watch for slips file (2-phase timeout: 45s appear + 45s parse)
  log("watching for slips file…");
  const result = await watchForSlips(cfg.repoRoot, {
    phaseATimeoutMs: 10 * 60_000, // 10 min for night-lead to respond
    phaseBTimeoutMs: 5 * 60_000,  // 5 min for clean parse
    pollIntervalMs: 2_000,
  });

  if (!result.appeared) {
    const noFile = `@${leadHandle} — no slips file appeared after 10 minutes. The night cannot start.`;
    log("slips file never appeared");
    await client.postMessage(roomId, noFile);
    return;
  }

  if (!result.parse?.ok) {
    const errors = result.parse?.errors ?? ["unknown parse error"];
    log(`slips parse errors: ${errors.join("; ")}`);
    await client.postMessage(roomId, slipErrorPost(errors));
    return;
  }

  const slips = result.parse.slips;
  log(`slips ready: ${slips.length} slip(s): ${slips.map((s) => s.id).join(", ")}`);
  await client.postMessage(
    roomId,
    `📋 Slips ready — ${slips.length} task(s) tonight:\n` +
      slips.map((s, i) => `${i + 1}. \`${s.id}\` ${s.title} → @${s.assignee}`).join("\n"),
  );

  for (const slip of slips) {
    await processSlip(ctx, slip, log);
  }

  log("all slips processed for this goal");
  await client.postMessage(roomId, `🌙 Night shift complete — ${slips.length} task(s) processed. Check PRs above.`);
}

// ---- main entry point -------------------------------------------------------

export async function main(): Promise<void> {
  // ---- config ----------------------------------------------------------------
  const envPath = join(SUPERVISOR_DIR, ".env");
  let envText = "";
  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    console.error(`[supervisor] cannot read ${envPath} — run the provisioner first`);
    process.exit(1);
  }
  const rawEnv = parseEnvFile(envText);
  let cfg: Config;
  try {
    cfg = loadConfig(rawEnv);
  } catch (e) {
    console.error(`[supervisor] config error: ${String(e)}`);
    process.exit(1);
  }

  const log = (...a: unknown[]): void => {
    console.log(`[supervisor ${new Date().toISOString()}]`, ...a);
  };

  // ---- room id ----------------------------------------------------------------
  const roomId = cfg.roomId;
  if (!roomId) {
    log("SWITCH_ROOM_ID not set — cannot post messages without a room id. Set SWITCH_ROOM_ID in supervisor/.env");
    process.exit(1);
  }

  log(`starting — agent ${cfg.agentId} in room ${roomId} (provider: ${cfg.provider})`);

  // ---- Switch client ----------------------------------------------------------
  let busy = false;
  const ctx: NightContext = { cfg, client: null as unknown as SwitchClient, roomId, busy };

  const client = new SwitchClient(cfg, {
    onConnection: (up, detail) => log(`connection ${up ? "UP" : "down"}: ${detail}`),
    onFatal: (reason, detail) => {
      log(`FATAL: ${reason} — ${detail}`);
      process.exit(reason === "taken_over" ? 0 : 1);
    },
    onDomain: (data, seq) => {
      listener.handleDomain(data, seq);
    },
  });
  ctx.client = client;

  const listener = new Listener({
    onAddressed: (msg) => {
      if (!msg.isHuman) return;        // only humans post tonight: goals
      if (!isGoal(msg.body)) return;   // ignore non-goal messages

      if (ctx.busy) {
        log("goal received but already running — ignored");
        client
          .postMessage(roomId, "I'm already running tonight's goal. Wait for the current shift to finish.")
          .catch(() => {});
        return;
      }
      ctx.busy = true;
      handleGoal(ctx, msg, log)
        .catch((err) => {
          log(`handleGoal error: ${String(err)}`);
        })
        .finally(() => {
          ctx.busy = false;
        });
    },
    onNonAddressed: (msg) => {
      log(`[room] non-addressed from ${msg.sender}: ${msg.body.slice(0, 60)}`);
    },
    onOtherDomain: (type, seq) => {
      log(`[domain] ${type} seq=${seq}`);
    },
  });

  // ---- signal handlers -------------------------------------------------------
  let stopping = false;
  const stop = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${sig} received — stopping`);
    client.stop();
    // give in-flight work 2s to drain before hard exit
    setTimeout(() => process.exit(0), 2000).unref?.();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  // ---- start -----------------------------------------------------------------
  client.start();
  log(`listening for "tonight: …" messages from humans in room ${roomId}`);
  log(`ledger: ${ledgerPath()}`);
}

// Run when this file is the entry point (not when imported by tests).
// ESM: import.meta.url === process.argv[1] comparison
const isEntry =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("main.js") || process.argv[1].endsWith("main.ts"));

if (isEntry) {
  main().catch((err) => {
    console.error("[supervisor] fatal startup error:", err);
    process.exit(1);
  });
}
