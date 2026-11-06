# Night Shift — Architecture

An overnight crew of AI coding agents that works in a Switch chat room like
real teammates: a human posts tonight's goal, a night-lead turns it into
strictly scoped taskslips, worker agents take one slip at a time on their own
branch and open PRs with receipts, a shift-supervisor validates receipts and
enforces CI with every merge gated behind human sign-off in the room, and at
9 AM the crew president — sorry, the supervisor — posts the shift report.

This file is plain-English documentation of every component: what it does,
how it talks to the other parts, and what breaks if you delete it. Components
below are listed in their planned build order; sections gain detail as each
phase actually builds them. *(Last updated: trust control tower, phase 7.)*

## Switch server (built phase 0)

The heart of the project and non-negotiable (hard rule 7). Switch owns the
room every participant lives in: it relays the bundled Mattermost chat into
its own room log, runs the agent protocol (event streams in with WebSocket
as the modern transport and SSE/long-poll kept for compatibility; HTTP
operations out), and exposes the operations agents use (`post_message`,
`read_context`, room tools). We pin `SWITCH_VERSION=0.31.0` and run the
published all-in-one stack from GHCR via Docker Compose with profiles
`collab` (Mattermost) and `gateway` (admin surface) — switched gateway on
port 3100 because 3000 is taken on this host. On this build agents cannot
edit their own settings (`update_agent_detail` refuses), so addressing and
agent management go through the owner side: the crew will be owned by the
admin account via a Gateway-created registration key. Delete it and there is
no shared world: no room, no messages, no agents, no night.

## Mattermost (bundled, phase 0)

The chat UI the team actually sees, bridged by Switch into the shared room
log — each agent gets its own bot account, and the human sees everything the
crew says. Delete it and the human loses the in-room view, but Switch still
logs rooms server-side.

## The crew template + schemas (built phase 1)

`crew/` is the crew's standard operating procedure:

- `nightshift.template.yaml` — a Switch room template (modeled on the repo's
  `triage-pair` example) that declares the whole crew: team prefix, provider
  and directory params, three agent slots (`{team}-night-lead` with
  `addressing: anyone`, and two `{team}-worker-N` slots with
  `addressing: owner-agents`, each with persona instructions), the
  `overnight-crew` room with the deployer in it, and a kickoff that makes
  each member state its one-line job. On this deploy the room block is
  applied through the Gateway's `POST /rooms/from-yaml` (the server posts
  the kickoff on the deployer's behalf) and the agents are registered
  against the core API with an admin-created registration key — the
  Console/machine path stays as the canonical zero-touch flow for a normal
  Console deployment. Delete it and recreating the crew becomes hand word.
- `taskslip.schema.md` / `receipt.schema.md` — the wire formats for work
  orders and receipts. Delete these and nothing downstream can trust
  anything a worker claims.
- `docs/rehearsal-transcript.md` — credential-free room evidence from the
  original crew bring-up.

## night-lead: {team}-night-lead (agent, built phase 1)

Turns the human's goal into taskslips (scope, acceptance criteria, files
allowed, time budget, backlog ref), writes them to `crew/taskslips/<date>.yml`,
and narrates assignments. Addressing `anyone`: the human talks to it directly.
It never writes code, and in phase 1 it proves this room-side — in the
rehearsal it answers the human and wakes the workers with one cue each.
The production taskslip flow is the supervisor's phase-2 job; night-lead's
template instructions already spell out the exact drill. Delete it and no
night ever starts, because nobody decomposes goals into safe units of work.

## {team}-worker-1 / {team}-worker-2 (agents, built phase 1)

Room personas: they acknowledge assignments, post negotiation claims in the
file-collision protocol (phase 4), and are the identities the trust stats
accrue to. Addressing `owner-agents`: they wake for the supervisor and
fellow crew members, never for a human's direct mention (demonstrated in
rehearsal: a user-class mention arrived addressed and the runtime held the
line — the server side does not refuse on 0.31.0, recorded in the deltas).
The actual coding is done by headless provider runs the supervisor spawns.
Delete them and the room has no voices to bargain with.

## supervisor/dev-tools/provision-crew.mjs + crew-rehearsal.mjs (built phase 1)

## headless workers (child processes, built phase 2)

`opencode run` (headless) inside `target/` on branch `shift/<task-id>`, fed
the taskslip text and the receipt requirements. They touch only the slip's
allowed files, run the test suite, and exit. Delete them and no code exists,
so no PRs and no receipts are possible.

## shift-supervisor (our protocol agent, Node 20+/TypeScript, built phase 2)

The machine the night runs on, living in `supervisor/`: registers itself
once with the Switch server as agent `shift-supervisor`, connects over the
agent protocol WebSocket (scope=all, filter=all, answers pings, resumes its
cursor), listens for the human's `tonight:` goals, delegates slips to
night-lead, spawns headless workers, opens draft PRs with the receipts
block, posts results to the room, gates merges behind human commands with
CI green (built phase 3), referees worker file collisions (phase 4), and renders
the 9 AM shift report from `supervisor/ledger.jsonl` (phase 5). Its only
runtime dependencies are Node's own WebSocket/fetch/fs. Delete it and
taskslips pile up unread: nothing merges, nothing is blocked, no report at
9 AM.

**Phase 2 internals (the full implementation):**

- `src/env.ts` — parses `supervisor/.env`; `loadConfig` / `testConfig`
  (the offline helper every test file imports); no runtime library.
- `src/ws.ts` — dependency-free RFC 6455 WebSocket client over
  `http.request` (upgrade event). Sends the `Authorization: Bearer <key>`
  header that Node's built-in `WebSocket` cannot attach. Answers pings with
  matching bytes for non-empty RFC keepalive pings; empty pings use the
  caller's cursor pong BEFORE dispatching events.
  Reconnects on drop; refuses takeover. Fully tested with an in-process
  server (`test/ws-harness.ts`).
- `src/switchclient.ts` — connection lifecycle on top of `ws.ts`. Builds
  the connection URL (`connection_id`, `rooms`, `start_from`, `expected_
  generation`), runs the ping watchdog (8s without ping → force close →
  resume), handles all frame types (connection_state, pong, evicted,
  gap, refused), advances and persists the cursor, posts messages and
  runs ops via HTTP. Reconnects on `heartbeat_lapsed`; stops final on
  `taken_over`.
- `src/state.ts` — cursor + generation persisted to `.state.json`
  (chmod 600, git-ignored) so restarts resume instead of replaying.
- `src/listener.ts` — classifies domain frames into `onAddressed` /
  `onNonAddressed` / `onOtherDomain`; identifies human senders by the
  bridge-puppet id pattern (`-user:`); extracts `@mention` handles.
- `src/slips.ts` — zero-library strict YAML parser for
  `crew/taskslips/<date>.yml`. Rejects the whole file on the first error,
  names the line and field. 8 test cases; no js-yaml.
- `src/goals.ts` — 2-phase watcher: phase A waits for the slips file to
  appear (fs.watch + 1s poll fallback); phase B re-parses on every mtime
  change until the file is clean. Clock is injectable for offline tests.
- `src/spawner.ts` — headless worker runner: clean-worktree check → branch
  from `origin/main` → provider child process with SIGTERM/SIGKILL budget
  kill-switch (detached process group, 5s SIGKILL grace) → collect diff +
  test run truth.
- `src/prs.ts` — `parseProviderReceipt` pulls the worker's own receipts
  block from its stdout; `renderReceipts` overlays the supervisor's facts
  (actual diff, actual test exit, measured minutes); `renderPrBody` wraps
  it in the PR body (scope, files_allowed, acceptance, receipts last);
  `createDraftPr` runs `git push` + `gh pr create --draft`; `ciStatus`
  reads the rollup from `gh pr view --json statusCheckRollup`.
- `src/main.ts` — the overnight loop: load config, start SwitchClient,
  wait for `tonight: …` from a human, nudge night-lead, watch for slips,
  post the slip roster to the room, then for each slip: post assignment
  narration + worker ack nudge → run the headless coder → open draft PR →
  post room summary (task id / branch / PR link / PASS|FAIL) → append a
  `ledger.jsonl` entry. SIGTERM/SIGINT cleanly stops the client.

## target/ — the petshop service (its own git repo, built phase 0)

A small Express API the crew works on: health, pet list with pagination, pet
create, pet detail. It has its own GitHub repo (`main` protected in spirit —
merges only via supervisor with human sign-off), unit tests, and CI. Its
`BACKLOG.md` holds six small pointed tasks; two of them are deliberately
curated to collide on the same file for the phase-4 negotiation showpiece.
Delete it and the crew has no product to build.

## Ledger (supervisor/ledger.jsonl, built phase 2, formalized phase 5)

Append-only machine truth of the night: every goal, assignment, PR, gate
result, rollback, block, negotiation, and report carries a timestamp and
actor. The room is the human view; the ledger is what we replay in tests
and demos. Delete it and there is no report, no trust stats, and no
reproducible evidence.

`src/ledger.ts` is the one write/read boundary: it appends JSONL without
rewriting existing bytes, tolerates and counts malformed historical lines,
normalizes task IDs from both task records and event refs, and opens a new
report window after each `report_posted`. New task records include the slip's
worker identity; older records remain honestly grouped as `unassigned`.

## 9 AM report (built phase 5)

`src/report.ts` deterministically folds the current ledger window into
Markdown: linked merges, rollback reasons, blocks, receipt gaps, per-worker
done/rollback/average-budget/trust figures, and one recommendation. Its trust
formula is deliberately visible in every report. Publishing is idempotent:
if today's report is already the last event and nothing followed it, later
room or CLI triggers reuse the artifact without another post or ledger line.

`src/clock.ts` schedules local 09:00 and recalculates after each run so clock
changes do not accumulate drift. `src/cli.ts` exposes `supervisor report`;
the live listener accepts the addressed room phrase `shift report please`.
All three paths call the same publisher, and only a successful room post
appends `report_posted`. Delete these modules and the ledger remains useful
machine data but the morning handoff disappears.

## scripts/verify.sh (built phase 0, grows every phase)

The always-green contract: every check prints labeled PASS/FAIL, offline
mode runs with zero AI calls and zero flaky networks, `--live` optionally
exercises the real stack. Night Shift never commits, and never builds, on a
red base. Since phase 1 it also runs `scripts/p1-checks.mjs`: the crew SOP
must literally parse (no YAML library — the template keys, the room roster,
the kickoff), the schemas must state their contracts, and the three crew
agents must exist, admin-owned, with the template's addressing rules.
Since phase 2 it also runs `scripts/p2-checks.mjs` (offline): the slips
parser rejects bad files and round-trips good ones, the receipt renderer
emits the §4.2 field order, `renderPrBody` puts the receipts block last,
`parseProviderReceipt` round-trips, `appendLedger` writes valid JSONL, and
the supervisor unit suite (now 101 tests including gates, night,
negotiation, reports, and the clock) passes.
Phase 3 adds `scripts/p3-checks.mjs` for gate refusals, exact receipt gaps,
cap planning, deadline continuation, and registry replay.
Phase 4 adds collision scanning and negotiated-order checks. Phase 5 adds
`scripts/p5-checks.mjs`: exact golden report replay, append/idempotency and
accelerated-clock tests, then a clean scratch-clone build and replay.
Phase 6 adds `scripts/p6-checks.mjs`: README quickstart commands, tracked
stack inputs, the three-outcome demo schema, and the submission checklist.
Delete it and nobody can ever again prove the phases keep working.

## Deterministic judge demo (built phase 6)

`demo/night.yml` is a bounded three-slip script: one merge, one rollback, and
one deliberate collision. `demo/run.mjs` creates an isolated Git remote from
target main, makes three branches, runs the real target tests, renders and
validates receipts, scans actual diffs, negotiates an order, forces and
resolves the rebase conflict, re-tests, applies the gate decisions, and folds
its append-only event stream through the production report renderer. `--live`
posts each stage through Switch; `--offline` prints the same transcript. Both
paths label the run as scripted and leave the target checkout and production
ledger untouched. Delete it and judges must manually reconstruct five phases
of behavior before they can see the product's complete trust loop.

`scripts/bootstrap.sh`, the tracked pinned Compose file, and the judge README
close the fresh-clone boundary. Bootstrap clones the separately versioned
target, installs locked dependencies, builds the supervisor, and generates
local secrets only when no `ops/.env` exists. Runtime secrets, agent state,
reports, and the nested target remain ignored.

## Trust control tower (built phase 7)

`crew/nightshift.policy.yml` is the repository owner's versioned boundary:
maximum diff size, maximum slip budget, paths blocked from overnight approval,
paths that require explicit review, and whether the independent reviewer is
required. `src/policy.ts` parses the small YAML contract and evaluates the
actual GitHub file list. Policy prose from an agent is never an input.

`src/reviewer.ts` compares four independent facts: GitHub's head SHA and file
list, the worker receipt, CI truth, and repository policy. A missing SHA,
receipt/diff mismatch, failed test proof, or blocked path becomes a challenge.
Sensitive paths become a visible human-review finding. `src/evidence.ts`
hashes those inputs into a stable evidence fingerprint and renders the compact
decision card posted through Switch.

Humans can ask `@shift-supervisor inspect <task-id>` without changing the PR.
Approval recomputes the same evidence at read time, posts it in Switch, and
calls GitHub merge with `--match-head-commit <reviewed-sha>`. A concurrent push
therefore fails the merge instead of inheriting an approval for older code.
The ledger records `policy_result`, `review_result`, gate, and merge events with
the SHA and fingerprint.

## supervisor/dev-tools/groundcheck.mjs (built phase 0)

The phase-0 proof, kept so the move-in is repeatable: registers an agent
(`ground-check`, owned by admin via a Gateway registration key), opens the
event stream, creates and joins room `shift-hangar`, and answers a human
`@ground-check …` message with a fixed reply. It documents the server
realities it discovered on this build (SSE needs `Accept: text/event-stream`,
ops results wrap in `{"result": …}`, self-setting prompts the owner path).
The production supervisor will reuse the same flows over the WebSocket
transport. Delete it and every future fresh install loses its smoke test.

The phase-1 pair beside it: `provision-crew.mjs` reads the template's agent
blocks and stands the crew up (registration through the admin formula,
addressing through the Gateway, room through `POST /rooms/from-yaml`),
and `crew-rehearsal.mjs` is one agent's rehearsal runtime — it loads the
agent's template persona, listens on the SSE transport, acts only on
addressed messages, answers with `opencode run` words, and self-enforces
the addressing rule. Delete the pair and standing the crew up after a
machine reset becomes guesswork.

## Trust gates + budgeted night (built phase 3)

`supervisor/src/gates.ts` parses addressed human `approve`, `rollback`, and
`hold` commands, validates the PR receipts against the receipt schema, and
reads current CI through `gh pr view`. Approval requires complete receipts,
PASS tests, and green CI at that read. Receipt gaps produce a needs-eyes
reply naming each gap. Approval makes a draft ready and merges it; hold
keeps or restores draft status. Rollback closes a draft and deletes its
remote branch, or lands a revert of a merged PR. The fallback reverts in
an isolated worktree and pushes main without changing a worker's checkout.
Merged tasks remain discoverable for rollback through ledger history.
Gate outcomes append `gate_result`, `merge`, `rollback`, `needs_eyes`, or
`error` events. The open registry is rebuilt from the ledger on startup.

`src/night.ts` processes slips sequentially with `NIGHT_MAX_SLIPS` (default
5) and a whole-slip deadline of budget plus `NIGHT_GRACE_MS` (default
180000; clamped to 5 seconds–30 minutes). Capped slips are named. A deadline
aborts worker and command process groups, prevents subsequent PR operations,
records a block reason, and continues. The provider's budget timer remains
the first kill switch. Cancellation flows through `main.ts`, `spawner.ts`,
`exec.ts`, and `prs.ts`; offline tests exercise real process cancellation.

The connection reconnect timer keeps the supervisor alive while its socket
is down. Optional `SUPERVISOR_WS_DEBUG=1` logs frame types and lengths, never
message bodies or credentials. Every client process needs its own connection
id. Typed commands replace reactions because reaction events do not reach
agents. See `docs/gates-manual.md` and `docs/phase-3-live-test.md` for the
manual, actual room evidence, and the disclosed assisted PR preparation.

## Collision negotiation (built phase 4)

`supervisor/src/negotiation.ts` compares the changed-file lists of open PR
branches against `origin/main`. An addressed human `negotiate <task> <task>`
command starts a room thread when the diffs overlap. The supervisor accepts
one claim from each distinct agent sender per round, checks the named paths
against the actual diff, and allows at most two rounds. Matching claims
produce an agreed landing order; contradictions escalate side by side. The
ledger records the scan and result. `gates.ts` enforces that an agreed second
PR waits for the first merge, a validated post-rebase receipt, and a branch
based on current main; normal receipt and green-CI gates still apply. The
live BACKLOG-5/6 rehearsal is in `docs/phase-4-live-test.md`.
