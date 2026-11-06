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
import {
  parseGateCommand,
  handleGateCommand,
  inspectTask,
  rebuildOpenTasks,
  appendGateEvent,
  type GateCommand,
  type OpenTask,
} from "./gates.js";
import {
  readNightLimits,
  runBudgetedNight,
  nightRosterPost,
  type NightLimits,
} from "./night.js";
import type { Slip } from "./slips.js";
import { scanCollisions, parseClaim, decideClaims, collisionPrompt, type Collision, type Claim } from "./negotiation.js";
import { exec } from "./exec.js";
import { appendLedgerLine, ledgerPath, type LedgerLine } from "./ledger.js";
import { publishShiftReport } from "./report.js";
import { startDailyClock } from "./clock.js";

// ---- ledger ------------------------------------------------------------------

export interface LedgerEntry extends LedgerLine {
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
  worker?: string;
}

export function appendLedger(entry: LedgerEntry): void {
  try {
    appendLedgerLine(entry);
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
  /** Open tasks + their PRs — the gate surface (rebuilt from the ledger). */
  registry: Map<string, OpenTask>;
  limits: NightLimits;
}

/** Result of one slip run — what the budgeted night reads per outcome. */
export interface SlipRunResult {
  blocked: boolean;
  reason?: string;
  testPass: boolean | null;
  prOk: boolean;
}

/** Run one slip end-to-end: worker run → PR → room post → ledger. */
async function processSlip(ctx: NightContext, slip: Slip, log: (...a: unknown[]) => void, signal?: AbortSignal): Promise<SlipRunResult> {
  const { cfg, client, roomId } = ctx;

  // 1. assignment narration + worker ack nudge
  const workerHandle = slip.assignee;
  const narration = assignmentNarration(slip, workerHandle);
  log(`[${slip.id}] posting assignment narration`);
  await client.postMessage(roomId, narration);

  // 2. run the headless coder
  log(`[${slip.id}] starting worker run (provider: ${cfg.provider})`);
  const wip = await runWorker(cfg, slip, log, { signal });
  if (signal?.aborted) return { blocked: true, reason: "slip deadline cancelled", testPass: null, prOk: false };

  // 3. push + PR (even on blocked — the branch may still have partial work)
  let prResult = { ok: false, prUrl: null as string | null, prNumber: null as number | null, output: "blocked before push" };
  if (!wip.blocked || wip.filesTouched.length > 0) {
    log(`[${slip.id}] opening draft PR`);
    prResult = await createDraftPr(cfg.targetDir, slip, wip, {
      provider: cfg.provider,
      ghRepo: cfg.ghRepo,
      signal,
    });
    if (!prResult.ok) {
      log(`[${slip.id}] PR failed: ${prResult.output.slice(0, 200)}`);
    }
  }

  if (signal?.aborted) return { blocked: true, reason: "slip deadline cancelled", testPass: null, prOk: false };

  // 4. room post (task id, branch, PR link, summary, PASS/FAIL)
  const attempt = parseProviderReceipt(wip.providerOutput, slip.id);
  const summary = attempt.summary ?? slip.title;
  const blockedReason = "reason" in wip ? (wip as unknown as { reason?: string }).reason : undefined;
  const roomPost = runSummaryPost(
    slip,
    prResult.prUrl,
    prResult.prNumber,
    wip.testPass,
    wip.blocked,
    blockedReason,
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
    reason: blockedReason,
    summary,
    filesChanged: wip.filesTouched.length,
    budgetMin: slip.time_budget_minutes,
    spentMin,
    worker: slip.assignee,
  };
  appendLedger(entry);

  // 6. an open PR registers the task for the gates (receipts + CI + approve)
  if (prResult.ok && prResult.prNumber !== null) {
    ctx.registry.set(slip.id, {
      taskId: slip.id,
      branch: `shift/${slip.id}`,
      prNumber: prResult.prNumber,
      prUrl: prResult.prUrl,
    });
  }

  log(`[${slip.id}] done — ledger appended`);
  return { blocked: wip.blocked, reason: blockedReason, testPass: wip.testPass, prOk: prResult.ok };
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
    `📋 Slips ready — ${slips.length} task(s) tonight (processing up to ${ctx.limits.maxSlips}):\n` +
      slips.map((s, i) => `${i + 1}. \`${s.id}\` ${s.title} → @${s.assignee}`).join("\n"),
  );

  // budgeted night: up to N slips sequentially, per-slip wall-clock deadline,
  // block-with-reason and CONTINUE on timeout (PHASE-PLAN 3.2)
  const { outcomes } = await runBudgetedNight(
    slips,
    ctx.limits,
    (slip) => {
      const controller = new AbortController();
      return {
        cancel: () => controller.abort(),
        p: processSlip(ctx, slip, log, controller.signal).catch((err) => ({
          blocked: true,
          reason: `slip crashed: ${String(err).slice(0, 160)}`,
          testPass: null as boolean | null,
          prOk: false,
        })),
      };
    },
    {
      log,
      onCapped: async (slip, ordinal) => {
        appendGateEvent("block", { task: slip.id, why: `night cap ${ctx.limits.maxSlips} — slip #${ordinal} not claimed tonight` });
        await client.postMessage(
          roomId,
          `🛏 \`${slip.id}\` — capped: the night processes at most ${ctx.limits.maxSlips} task(s); this one stays in the backlog.`,
        );
      },
      onDeadline: async (slip, deadlineMin) => {
        appendGateEvent("block", { task: slip.id, why: `slip deadline ${deadlineMin}min exceeded — worker stopped, night continues` });
        await client.postMessage(
          roomId,
          `⏰ \`${slip.id}\` — slip deadline of ${deadlineMin} min (budget ${slip.time_budget_minutes} min + grace) exceeded. The worker was stopped and **${slip.id}** is blocked; the night continues with the next slip.`,
        );
      },
      outcomeOf: (_slip, result) => {
        const r = result as SlipRunResult | undefined;
        if (!r || typeof r !== "object" || typeof (r as SlipRunResult).blocked !== "boolean") {
          return { status: "error" as const, reason: "slip produced no result record" };
        }
        return r.blocked
          ? { status: "blocked" as const, reason: r.reason ?? "blocked" }
          : { status: "done" as const, reason: null };
      },
    },
  );

  log(`budgeted night complete: ${outcomes.map((o) => `${o.taskId}=${o.status}`).join(", ")}`);
  await client.postMessage(roomId, nightRosterPost("🌙 Night shift complete — outcomes in order:", outcomes));
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
  const primaryRoomId = cfg.roomId;
  if (!primaryRoomId) {
    log("SWITCH_ROOM_ID not set — cannot post messages without a room id. Set SWITCH_ROOM_ID in supervisor/.env");
    process.exit(1);
  }

  // ---- gate registry (ledger is machine truth; gates survive restarts) --------
  const registry = rebuildOpenTasks(ledgerPath());
  const limits = readNightLimits(rawEnv);
  if (registry.size > 0) {
    log(`gate registry: ${registry.size} open task(s) from the ledger: ${[...registry.keys()].join(", ")}`);
  }
  log(`night limits: ${limits.maxSlips} slip(s) max, +${Math.round(limits.graceMs / 60_000)} min grace per slip`);

  log(`starting — agent ${cfg.agentId} in ${cfg.roomIds.length} room(s): ${cfg.roomIds.join(", ")} (provider: ${cfg.provider})`);

  // ---- Switch client ----------------------------------------------------------
  const ctx: NightContext = {
    cfg,
    client: null as unknown as SwitchClient,
    roomId: primaryRoomId,
    busy: false,
    registry,
    limits,
  };

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

  let reportBusy = false;
  const reportNow = async (trigger: "clock" | "room", targetRoomId = primaryRoomId): Promise<void> => {
    if (reportBusy) return;
    reportBusy = true;
    try {
      const artifact = await publishShiftReport(cfg.repoRoot, trigger, content => client.postMessage(targetRoomId, content));
      log(`shift report ${artifact.reused ? "reused" : "posted"}: ${artifact.relativeFile} (${artifact.eventCount} event(s))`);
      if (artifact.reused && trigger === "room") {
        await client.postMessage(targetRoomId, `Shift report already posted: \`${artifact.relativeFile}\`.`);
      }
    } catch (err) {
      log(`report error: ${String(err)}`);
      appendGateEvent("error", { report: trigger, why: String(err).slice(0, 200) });
    } finally {
      reportBusy = false;
    }
  };

  let negotiation: { roomId: string; collision: Collision; round: 1 | 2; claims: Map<string, { sender: string; claim: Claim }> } | null = null;
  const beginNegotiation = async (a: string, b: string, targetRoomId: string): Promise<void> => {
    if (negotiation) { await client.postMessage(targetRoomId, "A collision negotiation is already open."); return; }
    const tasks = [registry.get(a), registry.get(b)];
    if (!tasks[0] || !tasks[1] || a === b) { await client.postMessage(targetRoomId, `Unknown or duplicate open tasks: ${a}, ${b}`); return; }
    const fetched = await exec("git", ["fetch", "--quiet", "origin"], cfg.targetDir, 60_000);
    if (!fetched.ok) { await client.postMessage(targetRoomId, `Collision scan blocked: git fetch failed (${fetched.output.slice(-150)})`); return; }
    const matches = await scanCollisions(cfg.targetDir, [tasks[0], tasks[1]]);
    if (!matches.length) { await client.postMessage(targetRoomId, `${a} and ${b} have no changed files in common.`); return; }
    negotiation = { roomId: targetRoomId, collision: matches[0]!, round: 1, claims: new Map() };
    appendGateEvent("negotiation", { task: a, opponent: b, paths: matches[0]!.paths, round: 1 });
    await client.postMessage(targetRoomId, collisionPrompt(matches[0]!, 1));
  };
  const receiveClaim = async (msg: AddressedMessage): Promise<void> => {
    const session = negotiation;
    if (!session) return;
    if (msg.roomId !== session.roomId) return;
    const ids = [session.collision.left.taskId, session.collision.right.taskId];
    for (const id of ids) {
      const claim = parseClaim(msg.body, id, session.round);
      if (!claim || session.claims.has(id)) continue;
      if ([...session.claims.values()].some(v => v.sender === msg.sender)) return;
      session.claims.set(id, { sender: msg.sender, claim });
      if (session.claims.size < 2) return;
      const decision = decideClaims(session.collision, [...session.claims.values()].map(v => v.claim));
      if (decision.kind === "order") {
        appendGateEvent("negotiation_result", { task: ids[0], opponent: ids[1], agreed_order: decision.order, path: decision.path });
        await client.postMessage(session.roomId, `🤝 Agreed landing order for ${decision.path}: ${decision.order.join(" → ")}. First PR lands, then second rebases and re-tests before its gate.`);
        negotiation = null;
      } else if (session.round === 1) {
        await client.postMessage(session.roomId, `Round 1 needs clarification: ${decision.reason}. Claims: ${decision.claims.map(c => `${c.taskId}: ${c.first} first on ${c.paths.join(", ")}`).join(" | ")}`);
        session.round = 2; session.claims.clear();
        await client.postMessage(session.roomId, collisionPrompt(session.collision, 2));
      } else {
        appendGateEvent("negotiation_result", { task: ids[0], opponent: ids[1], status: "escalated", why: decision.reason });
        await client.postMessage(session.roomId, `👀 Collision escalated: ${decision.reason}. ${decision.claims.map(c => `${c.taskId}: ${c.first} first on ${c.paths.join(", ")}`).join(" | ")}`);
        negotiation = null;
      }
      return;
    }
  };

  const listener = new Listener({
    onAddressed: (msg) => {
      if (!msg.isHuman) { void receiveClaim(msg); return; }        // humans post goals + gate commands
      const replyRoomId = msg.roomId ?? primaryRoomId;

      if (/^(?:@shift-supervisor\s+)?shift report please$/i.test(msg.body)) {
        void reportNow("room", replyRoomId);
        return;
      }

      const startCollision = /^(?:@shift-supervisor\s+)?negotiate\s+(\S+)\s+(\S+)$/i.exec(msg.body);
      if (startCollision) {
        void beginNegotiation(startCollision[1]!, startCollision[2]!, replyRoomId).catch(err => log(`negotiation error: ${String(err)}`));
        return;
      }
      const inspect = /^(?:@shift-supervisor\s+)?inspect\s+([A-Za-z0-9][A-Za-z0-9._-]*)$/i.exec(msg.body);
      if (inspect) {
        void inspectTask({ cfg, client, roomId: replyRoomId, registry, by: msg.sender }, inspect[1] as string, { log });
        return;
      }
      // gate commands (§4.4) run even while a night is in flight
      const gate = parseGateCommand(msg.body);
      if (gate) {
        handleGateCommand(
          { cfg, client, roomId: replyRoomId, registry, by: msg.sender, },
          gate,
          { log },
        ).catch((err) => {
          log(`gate command error: ${String(err)}`);
        });
        return;
      }

      if (!isGoal(msg.body)) return;   // ignore non-goal messages

      if (ctx.busy) {
        log("goal received but already running — ignored");
        client
          .postMessage(replyRoomId, "I'm already running tonight's goal. Wait for the current shift to finish.")
          .catch(() => {});
        return;
      }
      ctx.busy = true;
      handleGoal({ ...ctx, roomId: replyRoomId }, msg, log)
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
  const reportHourRaw = Number(rawEnv.REPORT_HOUR ?? "9");
  const reportHour = Number.isInteger(reportHourRaw) && reportHourRaw >= 0 && reportHourRaw <= 23 ? reportHourRaw : 9;
  const firstDelayRaw = Number(rawEnv.REPORT_FIRST_RUN_MS ?? "");
  const reportClock = startDailyClock(
    () => reportNow("clock"),
    {
      hour: reportHour,
      ...(Number.isFinite(firstDelayRaw) && firstDelayRaw > 0 ? { firstDelayMs: firstDelayRaw } : {}),
    },
  );
  log(`next shift report: ${reportClock.nextRun.toISOString()} (local hour ${reportHour})`);

  let stopping = false;
  const stop = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${sig} received — stopping`);
    reportClock.stop();
    client.stop();
    // give in-flight work 2s to drain before hard exit
    setTimeout(() => process.exit(0), 2000).unref?.();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  // ---- start -----------------------------------------------------------------
  client.start();
  log(`listening for "tonight: …" messages from humans in rooms ${cfg.roomIds.join(", ")}`);
  log(`ledger: ${ledgerPath()}`);
}

// Run when this file is the entry point (not when imported by tests).
// ESM: import.meta.url === process.argv[1] comparison
const isEntry =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("main.js") || process.argv[1].endsWith("main.ts"));

if (isEntry) {
  process.on("exit", (code) => console.error(`[supervisor] process exiting, code=${code}`));
  process.on("beforeExit", (code) => console.error(`[supervisor] beforeExit: event loop draining (code=${code})`));
  process.on("uncaughtException", (err) => {
    console.error(`[supervisor] uncaughtException: ${String(err)}`);
    console.error(err?.stack ?? "(no stack)");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[supervisor] unhandledRejection: ${String(reason)}`);
    process.exit(1);
  });
  main().catch((err) => {
    console.error("[supervisor] fatal startup error:", err);
    process.exit(1);
  });
}
