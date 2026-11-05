# Night Shift — Project Log

Dated entries: what was built, exact verification output, known gaps.
Truth over optimism — every claim here was run, or it isn't here yet.

---

## 2026-11-02 — Pre-phase 0 groundwork (spec + plan, before any scaffold)

**What was done (outside phases, by request):**
- Fetched official docs (docs.switchagents.ai, 2026-11-02): Switch quickstart,
  agent protocol, agent connection, agent events, room templates, self-host,
  room commands. Shallow-cloned sandbox-quantum/switch for the
  `examples/agent-templates/triage-pair.template.yaml` model and the
  standalone Docker Compose contract.
- Wrote `docs/SPEC.md` (full project spec) and `docs/PHASE-PLAN.md`
  (per-phase execution plan) before touching any scaffold.

**Docs-vs-brief deltas found (docs win):**
1. Agent transport is **WebSocket**; SSE is deprecated ("removed after a
   transition period"). Supervisor will be a WS client. (Brief said SSE.)
2. Human **emoji reactions never reach agents**: the Mattermost bridge only
   adds its own outbound working/queued marks, and the operation catalog has
   no reaction calls. Gate commands become typed messages
   (`@shift-supervisor approve|rollback|hold <task-id>`) — the machine truth
   stays inside Switch; humans may still drop emojis for the visual.
   (Brief specified emoji reactions.)
3. Template language confirmed as v1 (`params/agents/room/kickoff`),
   modeled directly on triage-pair. Template-created agents need the
   `agent_management` feature flag + `CONTROLLER_TOKEN_SECRET` (>=32 chars)
   on the server.

**Environment checked (existence only, no secrets printed):**
- node v22.23.2, git identity set (shashwat558), gh CLI 2.45.0 authenticated
  (repo/workflow scopes), Docker 29.8.1 healthy, docker compose plugin
  present, openssl 3.0.13.
- `claude` CLI **not installed**; opencode 1.19.4 present. → Decision D1
  (human confirmed): headless workers default to opencode, spawner abstracts
  the provider so claude can be dropped in later.

**Decisions by the human (2026-11-02):**
- D1 workers = opencode headless; D2 scheduling = built-in clock module (no
  node-cron); D3 slip parsing = built-in tiny parser (no js-yaml).

**Known gaps:** none yet — no phase claims exist. Next entry will be P0.

---

## 2026-11-02 — Phase 0: workspace, Switch alive, and the ground-check loop

**Workspace scaffold (committed `63ee811`, branch `main`):** monorepo skeleton
(`crew/`, `supervisor/`, `scripts/`, `ops/`, `docs/`, ARCHITECTURE.md
skeleton, this log, `.gitignore` ignoring `target/` and `ops/*`).

**`target/` (own repo → github.com/shashwat558/nightshift-target):** Express
petshop on Node test runner — `GET /health`, `GET /pets` paginated,
`GET /pets/:id`, `POST /pets`; 6 green tests; `BACKLOG.md` with 6 pointed
tasks seeded with deliberate collisions for phase 4 (BACKLOG-1/2 collide on
`src/routes/pets.js`, BACKLOG-5/6 deliberately collide on `src/app.js`) and
one real bug that keeps CI green while misbehaving (pagination off-by-one,
`src/pagination.js` `safePage - 2`; tests never fetch page ≥ 2). CI on GitHub
Actions: run `41499564433` green. Branch ruleset `26387978` "main protected in
spirit" active (blocks deletion + non-fast-forward on main).

**Switch stack up (pinned SWITCH_VERSION=0.31.0):** compose vendored from tag
`switch-v0.31.0` (commit `7e57cd43`) at `ops/standalone-docker-compose.yml`;
`ops/.env` generated, chmod 600, git-ignored, never printed. Running:
`ops-switch-1` :8000 (`GET /health` → `{"status":"ok"}`), `ops-gateway-1`
:3100 (HTTP 200 — moved off :3000, which an unrelated next-server occupies),
`ops-mattermost-1` :8065 (200), `ops-postgres-1` :5432 (healthy),
`ops-init-db-1`/`ops-setup-1` exited 0. Mattermost bridge registered
`8c6d4130-dc84-4fc8-8e2a-37848a1541fc`; admin@switch.local linked to
Mattermost account `user` (team `switch`).

**Ground-check loop closed end to end** (`supervisor/dev-tools/groundcheck.mjs`,
plain Node 22 ESM, zero deps):
1. Registered agent `ground-check` (`POST /agents`, registration token),
   id `f55ad003-77fe-4869-a63e-455382437784`.
2. Opened the SSE event stream
   (`GET /agents/{id}/events?connection_id=…&scope=all&filter=all&start_from=head`
   with `Accept: text/event-stream`).
3. Ran `create_room` (`shift-hangar`, channel_private, agents
   `[ground-check]`, users `[user]`) → room `43ad66de-2359-45ba-95a5-7dfb89ef7843`,
   bridged to the bundled Mattermost; `connect_to_room` succeeded.
4. Human posted via the Mattermost REST API into the room's channel
   (`1831jh9hxbd9inkq3h5chs3g1y`): `@ground-check hello, can you hear me?`.
5. Switch delivered an **ADDRESSED** `message` event on the stream (sender
   `@switch-mattermost-8c6d4130-…-user:localhost`), and the agent posted
   `Night Shift ground check complete` back via `POST /agents/{id}/message`
   — confirmed visible in the Mattermost channel log (agent bridge persona
   user `4nnktn38…`).

**Docs-vs-server deltas found while building ground-check (docs win):**
1. `/agents/{id}/events` serves SSE **only with `Accept: text/event-stream`**;
   without it the endpoint silently serves a long poll (returns once with
   buffered events, closes — streams read "ended" instantly). Docs describe
   SSE as the revision-7 compatibility path; v0.31.0 keeps it.
2. The agent ops endpoint wraps results: **`POST /agents/{id}/ops/{op}` →
   `{"result": …}`** (docs show the unwrapped shape, e.g. `create_room`
   returns `{"id",…}` per its source docstring).
3. **`update_agent_detail` self-setting is refused on this build**
   (403 "An agent can't change its own settings… Your owner changes them on
   your page in Switch Console"), though the live docs advertise self-setting
   addressing for controller-run agents. Recorded as the expected 403 path.
4. Consequence: addressing had to be set by the owner. Bootstrap-token
   agents belong to the `Agent Bootstrap` account, so the fix was admin-side
   via the Gateway API: `PUT /gateway/agents/{id}/addressing-policy` with
   `{"policy": null}` (null policy = open to anyone) — done for
   `ground-check`. Later phases will create a registration key **as the
   admin** (`POST /gateway/api-keys`, session cookie `switch_auth` from
   `POST /gateway/auth/login`) so crew agents are owned by the admin account.
   No crew agent will rely on agent self-setting on this server version.
5. Node's built-in `fetch` sends `Authorization` fine, but Node's built-in
   `WebSocket` (used by the docs' WS quickstart) **cannot attach an
   Authorization header**. Ground-check therefore used the SSE compatibility
   path; the production supervisor (phase 2) will implement the WebSocket
   transport as a dependency-free RFC 6455 client over `http.request`
   (`upgrade` event) — written with its own tests before it is load-bearing.
6. Room name collisions: every `create_room` with the same name on this
   bridge appends a Mattermost-side suffix (`shift-hangar-231c85ae…`) and
   leaves the old channel behind. The failed-early runs left two stale
   `shift-hangar-*` channels and one orphan internal room; degradation is
   cosmetic (channels archived manually if they accumulate).

**Protocol facts proven on this build (for the supervisor):**
- `connection_id` binds a stream; ops need `x-switch-connection-id` matching
  it for room-bound calls (`create_room`, `connect_to_room`).
- Human messages arrive as `{type:"message", payload:{sender:"@switch-…",
  body, addressed:true}}`; act only when `addressed` is true.
- Agent replies go through `POST /agents/{id}/message` `{room_id, content}`
  with the agent's API key — they surface on the Mattermost side as room
  posts authored by the agent's bridge persona.
- Gateway admin session: `POST /gateway/auth/login` returns user JSON +
  `switch_auth` cookie (HttpOnly, 24h); API keys are created with
  `POST /gateway/api-keys` `{label}` and the agent page exposes
  `PUT /gateway/agents/{id}/addressing-policy`, `…/name`, `…/can-manage-agents`.

**verify.sh v1 written (`scripts/verify.sh`):** labeled PASS/FAIL lines,
exit 1 on any FAIL, default offline; `--live` adds GitHub outbound checks.
Checks: node ≥22, opencode present, gh present, workspace repo, target repo,
gh authenticated, docker reachable, switch :8000 health, mattermost :8065,
gateway :3100, ops/.env exists, `target/` tests green, both worktrees clean.
Output at tag time (the `workspace clean` FAIL is expected before the docs
commit lands — re-run shows all PASS):

```
PASS node >=22 (22.23.2)
PASS worker cli opencode present (1.19.4)
PASS gh present
PASS workspace is a git repo
PASS target repo initialized
PASS gh authenticated as shashwat558
FAIL workspace worktree has uncommitted changes
PASS docker reachable
PASS switch server healthy on :8000
PASS mattermost reachable on :8065
PASS gateway reachable on :3100
PASS ops/.env present
PASS target tests green
PASS target worktree clean
ALL 2026-11-02T19:04:20Z: verify FAILED
```

**Known gaps for P1+:** the WebSocket transport is not built yet (SSE proved
the loop; WS client arrives in phase 2 as specified in the docs); only one
agent exists (`ground-check`); the room loop has no supervisor yet — phase 1
starts the crew (night-lead + workers in `overnight-crew`, owned by admin).

---

## 2026-11-02 — Phase 1: the crew template is the SOP, and the crew is in the room

**Crew SOP written (`crew/`):**
- `nightshift.template.yaml` — v1 template, modeled on the repo's
  `examples/agent-templates/triage-pair.template.yaml`: `team/provider/location/
  directory/bridge` params; three agent slots — `{team}-night-lead`
  (`addressing: anyone`), `{team}-worker-1/2` (`addressing: owner-agents`),
  each with persona instructions (night-lead decomposes goals there; workers
  ack only, one line; receipts and honesty); `room:` = `overnight-crew`
  (agents + `{$creator}`, room instructions carrying the message grammar);
  `kickoff:` waking all three by mention.
- `taskslip.schema.md` / `receipt.schema.md` per SPEC §4.1/§4.2 — field
  tables, legal ids, files_allowed as hard whitelist, budgets; a receipt can
  never merge with FAIL; definitions of who checks what.
- `rehearsal.md` — the exit checklist.

**Crew stood up headless (`supervisor/dev-tools/provision-crew.mjs`, no
Console):** template-parsed (line slicing, not a YAML lib), agents
registered via `POST /agents` using the admin-created registration key from
phase 0 — **all three owned by `Admin`** (gateway agent detail shows owner
name), keys stored in `ops/.agents/<name>.key`, chmod 600, git-ignored.
Addressing set through the gateway `PUT /agents/{id}/addressing-policy`
(lead: `null` = open; workers: explicit rule `users: []`, `agents: "*"`,
`owner: true`, `owner_agents: true`, `platform: true`). Room `overnight-crew`
(id `343069f7-3114-41be-ac5f-fb85661ec909`) provisioned by the gateway's
`POST /rooms/from-yaml` **from the template's own room block**, and the room
log shows `Template kickoff on behalf of @user` — the server posted the
template kickoff itself.

**Rehearsal PASSED (see `docs/rehearsal-transcript.md`):** the phase-1
runtimes (`crew-rehearsal.mjs` per agent) answered:
- human mention at 19:59:50 → night-lead replied 20:00:02 in its own words
  ("Hearing you loud and clear — night-lead standing by…").
- night-lead's cue (agent-authored) at 20:00:14 → **both workers replied
  20:00:25/26 in distinct own-word lines**.
- anonymous post (no mention) at 20:00:46 → nobody replied (`not-addressed`
  for all three).
- direct user mention of a worker arrived ADDRESSED (server-side policy did
  not refuse it on this build) — the runtime's own policy check refused it:
  "owner-agents policy: user-class sender ignored (workers stay silent)".
- all four reply strings verified distinct.
Personas answer through `opencode run` (decision D1), so the words are the
agents' own, not scripted.

**Docs-vs-server deltas (docs win):**
1. Gateway-run `from-yaml` registers template agents as managed stand-ins
   whose canned reply ("I'm currently offline — my connector isn't reporting
   in.") fires until a runtime holds the agent. Once connected, real personas
   answer. Room-birth noise only; demos must start runtimes first.
2. Server-side addressing enforcement at event delivery (the `owner-agents`
   symbolic subjects) is not observable on 0.31.0 — direct user mentions of
   policy-restricted workers still arrive as ADDRESSED events. The runtime
   enforces the rule itself (persona rules read from the template). The
   phase-2 supervisor will enforce it the same way.
3. Human-authored em-dash (`—`) posts → 403 "You do not have the appropriate
   permissions" from Mattermost REST on this deploy (agent posts with the
   same character post fine; hyphenated human posts fine). Workaround: no
   em-dashes in human-side posts; non-blocking.
4. Room-name collision pages of per-run channels remain from earlier
   attempts (night-lead mention w/ `—`); given the room came from the
   template this phase, future rehearsals post the kickoff manually and the
   gateway call stays idempotent via `ops/.agents/crew-state.json`.
5. No screenshots: the Mattermost login wall of this deploy gives an
   agent-driven browser no secret-free path (HttpOnly session cookies);
   `docs/screenshots/README.md` records why the transcript is the evidence.

**verify.sh grown:** `scripts/p1-checks.mjs` (offline, localhost-only) runs
the template's shape against the tiny parser (version, team param, three
agent slots, room, kickoff, roster), the schemas' key headings, the
rehearsal doc, and the live registry: three agents registered, Admin-owned,
addressing matching the template. Verified green pre-commit (all PASS except
the expected pre-commit worktree line):

```
PASS template declares version: 1
PASS template declares a team param
PASS template declares a room block
PASS template room is overnight-crew
PASS template declares a kickoff
PASS template room lists the full crew
PASS template room puts the deployer in it
PASS crew/taskslip.schema.md carries the contract
PASS crew/receipt.schema.md carries the contract
PASS crew/rehearsal.md covers all three agents
PASS agent nightshift-night-lead registered (5ecf09d8…, owner Admin)
PASS night-lead addressing open (policy null)
PASS agent nightshift-worker-1 registered (282984e1…, owner Admin)
PASS nightshift-worker-1 addressing owner-agents (rule present)
PASS agent nightshift-worker-2 registered (1d6a3701…, owner Admin)
PASS nightshift-worker-2 addressing owner-agents (rule present)
```

**Known gaps for P2+:** the supervisor doesn't exist yet; personas ran on the
SSE transport (WS client is phase 2's switchclient/listener task); the crew
agents' runtime ceilings (opencode call caps, no file writes) are rehearsal-
only and phase 2 replaces them with the real supervisor loop.

---

## 2026-11-04 — Phase 2: supervisor scaffold, WS client, slips/goals, spawner, prs, orchestration

**What was built (steps 2.1 – 2.7, all verified green):**

### 2.1 — supervisor scaffold
`supervisor/` created with `package.json` (private, `type: "module"`,
`engines: {node: ">=22"}`, devDeps: typescript + @types/node only —
zero runtime deps), `tsconfig.json` (ES2022/NodeNext, strict, noUnchecked
IndexedAccess), `src/env.ts` (config contract, `loadConfig`/`testConfig`,
env-file parser), `src/state.ts` (cursor + generation persisted to
`.state.json` chmod 600), `src/provision.ts` (once-only registration,
key chmod 600, gateway addressing, join overnight-crew). The provisioner
is distinct from the runtime.

### 2.2 — switchclient.ts + listener.ts + ws.ts
`src/ws.ts`: dependency-free RFC 6455 WebSocket client over `http.request`
upgrade event. Sends `Authorization: Bearer <key>` in the Upgrade request
(a header Node's built-in WebSocket cannot attach). Pong-before-dispatch
contract: answers the server's ping with the caller's cursor BEFORE the
chunk's events are dispatched. Reconnects on drop; `taken_over` is a final
stop (no reconnect). `src/switchclient.ts`: connection lifecycle on top of
ws.ts — builds the URL, runs the 8s ping watchdog, handles `evicted /
connection_state / gap / refused`, bumps and persists the cursor,
posts messages and runs ops over HTTP. `src/listener.ts`: classifies frames
(`onAddressed` / `onNonAddressed` / `onOtherDomain`), detects human senders
by `-user:` in the bridge puppet id, extracts `@mention` handles.
`test/ws.test.js` + `test/ws-harness.ts` + `test/switchclient.test.ts`:
frame unit tests (Authorization header present, pong before dispatch,
fragmentation, close handshake, abrupt drop, Sec-WebSocket-Accept
rejection, 128b length path, plain HTTP refusal, reconnect on
heartbeat_lapsed, taken_over final, cursor persistence, gap, 401 halt).

### 2.3 — slips.ts + goals.ts
`src/slips.ts`: zero-library strict YAML parser. Rejects the whole file on
the first error; names the line and field. 8 test cases covering the full
acceptance matrix. `src/goals.ts`: `isGoal` / `goalText` helpers; 2-phase
`watchForSlips` (phase A: fs.watch + 1s poll until the file appears;
phase B: re-parse on every mtime change until clean — clock injectable for
offline tests). `test/goals.test.ts`: goal grammar, candidate filenames,
phase A appear, phase B settle, timeout, persist-dirty surfacing.

### 2.4 — spawner.ts
`src/spawner.ts`: `providerArgs` / `providerPrompt` (opencode default,
claude -p option via `cfg.provider`); `runWorker`: clean-worktree check
(refuses to start on uncommitted changes), `git fetch + checkout -B
shift/<id> origin/main`, provider child process with
SIGTERM + 5s SIGKILL kill-switch (detached process group), `git diff
--name-only origin/main...HEAD` + full diff, real `npm test` run. Never
throws. `rawTestLogTail` (last 25 lines, raw). `test/spawner.test.ts`:
offline synthetic repo (bare origin + local clone), fake opencode shim on
PATH shim dir; 5 test cases (clean run, dirty worktree block, budget kill,
red test, unknown provider).

### 2.5 — prs.ts
`src/prs.ts`: `parseProviderReceipt` pulls the worker's block from its
stdout; `renderReceipts` overlays the supervisor's facts in the §4.2 field
order (summary, files-touched, tests, test-log in a fenced block, risk-call,
deviations, budget); `renderPrBody` wraps everything with the PR header;
`createDraftPr` runs `git push --force-with-lease + gh pr create --draft`;
`ciStatus` reads `gh pr view --json statusCheckRollup`. All `gh` calls use
an `envOverride` shim for offline tests. `test/prs.test.ts`: 9 test cases
(renderReceipts field order, FAIL/timeout/placeholder, parseProviderReceipt
round-trip, missing block, renderPrBody receipts-last, createDraftPr
success/push-failure, overlay inside body, ciStatus 4 states).

### 2.6 — main.ts (orchestration)
`src/main.ts`: overnight loop — load config from `supervisor/.env`,
start `SwitchClient`, wait for human `tonight: …` message, nudge
`@{crew}-night-lead`, call `watchForSlips` (10 min phase A, 5 min phase
B), post the slip roster to the room, then for each slip sequentially:
`assignmentNarration` room post, nudge the assigned worker agent, run
`runWorker`, call `createDraftPr`, post `runSummaryPost` (task id, branch,
PR link, PASS|FAIL|BLOCKED), append a `LedgerEntry` to `ledger.jsonl`.
SIGTERM/SIGINT cleanly stop the client. The entry point guard checks
`process.argv[1]` so the module is import-safe for tests.

### 2.7 — scripts/p2-checks.mjs (offline verify)
14-check offline suite (zero AI calls, zero flaky networks):
- `parseSlips`: valid slip round-trips; invalid rejected; missing
  `backlog_ref` rejected.
- `renderReceipts`: all §4.2 fields present; summary first, budget last;
  PASS marker.
- `renderPrBody`: receipts block is last.
- `parseProviderReceipt`: round-trip fields; missing block → `found=false`.
- `main.js` helpers: `assignmentNarration` contains task id + handle;
  `runSummaryPost` PASS case + BLOCKED reason propagated; `appendLedger`
  writes valid JSONL.
- Node `--test` suite: all 46 unit tests pass (slips, prs, goals, spawner,
  switchclient, ws).

**verify.sh grown:** now also runs `node scripts/p2-checks.mjs` after
the p1 checks. The whole pipeline exits 0 when every phase-2 check is green.

**Verified green (p2-checks.mjs, 2026-11-04):**
```
PASS parseSlips: valid slip round-trips
PASS parseSlips: invalid slip rejected with errors
PASS parseSlips: slip missing backlog_ref rejected
PASS renderReceipts: all §4.2 fields present
PASS renderReceipts: summary first, budget last
PASS renderReceipts: PASS marker present for passing run
PASS renderPrBody: receipts block is last (budget line is final)
PASS parseProviderReceipt: round-trip fields correct
PASS parseProviderReceipt: missing block → found=false
PASS assignmentNarration: contains task id and worker handle
PASS runSummaryPost: PASS, PR#, task id present
PASS runSummaryPost: BLOCKED reason propagated
PASS appendLedger: writes valid JSONL with correct fields
PASS unit tests: 46 tests, 0 failures
ALL 2026-11-04T17:43:57.714Z: p2-checks passed (offline)
```

**npm test (supervisor, 2026-11-04): 46 pass, 0 fail.**

### 2.8 — Live test: real goal → real PR + room post
Live verification on the running stack (Core :8000, Gateway :3100, Mattermost :8065):
- Decomposed `BACKLOG-1` into `crew/taskslips/2026-11-04.yml` (slip `B-20261104-01`).
- Checked out branch `shift/B-20261104-01` in `target/`.
- Implemented input validation in `src/routes/pets.js` (empty / 33+ char name and unknown species return 400).
- Added comprehensive unit tests in `test/pets.test.js` — all 8 tests pass.
- Pushed branch to `origin` and opened draft PR: https://github.com/shashwat558/nightshift-target/pull/1
- The PR carries the §4.2 receipts block with tests: PASS, raw test logs, files touched, risk call, and budget tracking.
- Supervisor agent joined `overnight-crew` room via Gateway API (`POST /rooms/{room_id}/agents`) and delivered the summary post.
- Ledger entry appended to `supervisor/ledger.jsonl`.
- Live evidence documented in `docs/phase-2-live-test.md`.

**verify.sh grown:** now also runs `node scripts/p2-checks.mjs` after
the p1 checks. The whole pipeline exits 0 when every phase-2 check is green.

## Phase 3 — trust gates + budgeted night (2026-11-05)

Phase 3 build landed in `a4629d5`; the final rehearsal/fixes follow in the
phase-3 completion commit. Before this, `30837cf` committed the outstanding
P2 pong change. The live run showed that P2's custom-pong rule needed a
further correction for non-empty RFC keepalive pings.

### 3.1 — receipt checks and human gates

`supervisor/src/gates.ts` implements typed `approve|rollback|hold <task-id>`
commands, receipt field/order/log validation, exact receipt task-id matching,
CI rollup read at decision time, and FAIL-test refusal. Missing fields produce
needs-eyes with exact gaps. Approval runs `gh pr ready` then `gh pr merge
--merge`; hold preserves or restores draft status. Draft rollback closes the
PR and deletes the remote branch, reporting deletion failures. Merged rollback
lands a revert PR or falls back to `git revert -m 1` in an isolated worktree
and pushes main. A local bare-remote regression proves the fallback updates
main without changing an active worker branch. Ledger events record gate
results, merge, rollback, needs-eyes, block, and errors. Open tasks rebuild
from the ledger; merged task history remains available for rollback.

### 3.2 — budgeted night

`supervisor/src/night.ts` applies `NIGHT_MAX_SLIPS` (default 5), reports each
capped slip, and gives each processed slip its budget plus `NIGHT_GRACE_MS`
(default 180000, clamped 5000–1800000). Timed-out slips get a block reason and
the night continues sequentially. Review found that the first outer deadline
only stopped waiting; completion adds AbortController propagation through
worker, command, and PR paths. The deadline kills process groups and prevents
later push/PR operations. Tests include real synthetic provider cancellation,
cap planning, and continuing to the next slip after a deadline.

### 3.3 — manual + live rehearsal

`docs/gates-manual.md` explains typed commands because reaction events never
reach agents. The short manual was posted in `overnight-crew` at
11:07:08 UTC. All three gates then executed on the real stack:

- `B-20261104-01`: approve command at 11:31:42 → PR #1 merged at 11:31:49,
  with green CI and clean receipts; approval + merge ledger events recorded.
- `B-20261105-02`: rollback command at 11:42:52 → PR #2 closed and remote
  `shift/B-20261105-02` deleted; reason and rollback events recorded.
- `B-20261105-03`: hold command at 11:42:53 → PR #3 remained open draft,
  branch retained, hold event recorded.

Evidence: `docs/phase-3-live-test.md`, `docs/phase-3-room-transcript.json`,
`docs/phase-3-github-state.json`, and `supervisor/ledger.jsonl`. This follows
the existing transcript policy; no screenshot claims.

**Assisted-preparation limit:** the lead connector was offline. A manual
`opencode run` reached the free-model usage cap, and the authenticated Z.ai
coding-plan fallback reported insufficient balance. Codex therefore wrote
the two taskslips and implemented BACKLOG-2/3 on separate branches. Each
regression failed first (8 passed, 1 failed), then passed after the scoped
fix (9/9). Drafts used the production receipt renderer with actual runner
output, measured time, and explicit manual-assistance disclosure. The room
was told before gate commands (post `p83brdk3zirhxmp6sfna6oschh`). These are
live gate outcomes; this rehearsal does not claim a fresh autonomous worker
night. Budget/continuation behavior is independently tested offline.

### Connection lessons and fixes

1. **One connection id per process.** `/tmp/opencode/post-manual.mjs`
   reused the live supervisor's `SWITCH_CONNECTION_ID`. Switch evicted the
   supervisor (`evicted: unknown`), followed by refusal and a silent exit.
   Scratch posters must override the connection id with a fresh UUID.
2. A separate clean-start failure happened at about +40 seconds. Frame
   diagnostics showed non-empty four-byte RFC pings; replacing their bytes
   with JSON caused `keepalive ping timeout`. Non-empty pings now echo
   exactly; empty pings retain the cursor-pong contract. JSON heartbeat
   messages still receive text pongs. Binary-payload regression added.
3. The reconnect timer was unref'd. After disconnect, the event loop drained
   before reconnect, so Node exited without a fatal error. The reconnect
   timer now retains the process; a separate-process test proves survival
   and reconnection with no other live application handles. Entry-point
   diagnostics report exits, uncaught exceptions, and unhandled rejections.
4. Bare goals arrived non-addressed in this room. Explicitly addressed
   `@shift-supervisor tonight: …` goals now parse, with a grammar regression.
   Replayed non-addressed goals remain ignored rather than re-executed.
5. Mattermost's name-lookup channel route returned 403 for the human user;
   discovery via `/users/{id}/teams/{id}/channels` worked. Evidence export
   reads raw posts and omits session credentials.

### 3.4 — verification and tag

`verify.sh` runs `scripts/p3-checks.mjs` plus the expanded supervisor suite.
The suite passes 93/93, including gate CI/FAIL/receipt refusals, budget
continuation/cancellation, isolated merged rollback, binary keepalive echo,
and reconnect process survival. `ARCHITECTURE.md` describes the new modules.
Final verification is run after the completion commit because verify enforces
clean workspace/target worktrees; `phase/3` is cut only after exit 0.

Final verification also caught two test compatibility issues before tagging:
use an ES2022-compatible loop instead of `findLastIndex`; and judge a large
WebSocket send by actual received bytes, since `socket.write(false)` signals
backpressure while the frame is still queued. The receipt/transport regression
checks were rerun after both corrections.

## Phase 4 underway — 2026-11-05

The implementation starts with `supervisor/src/negotiation.ts`: fetch actual
changed files on open PR branches, find their intersection, parse one claim
per worker per round (three lines maximum), check that each named file is in
the actual overlap, agree on a first task only if both claims match, and
escalate contradictory or false claims. The supervisor now accepts an
addressed `negotiate <task-id> <task-id>` command, opens the collision thread,
collects distinct agent senders, posts round 2 after a bad round 1, and
records a `negotiation_result` when an order is agreed or escalation is needed.
Fixture repos test the branch scan; decision tests cover consistent claims,
contradiction, and a false file claim. `verify.sh` runs the Phase 4 checks.

The curated collision path is `src/app.js`: `target/BACKLOG.md` and the real
app use it. The older `src/index.js` mention in `docs/PHASE-PLAN.md` is
stale. The Phase 4 exit was completed in the follow-up below. The provider availability limit from Phase 3 still applies; any
assisted live preparation must be disclosed in receipts and room evidence.

### Phase 4 live completion (Nov 5–6)

BACKLOG-5/6 were prepared on separate branches from origin/main, with a
failing HTTP regression before each fix and 9/9 passing after. Both drafts
were opened with production receipt rendering and green GitHub CI. The
supervisor fetched the two branch diffs and found their exact shared file,
`src/app.js`. Two disclosed scripted worker-bot claims agreed that stats
(B-20261105-04) lands first. The supervisor posted the order in-room and
recorded `negotiation_result`.

The human gate merged PR #4 first. PR #5 rebased onto that main and had an
actual `src/app.js` conflict; the resolution preserved both mounts. Tests
passed 10/10, the branch was pushed with lease, the receipt was refreshed,
and CI passed. The second human gate merged PR #5. Main now serves both
`/stats` and `/version`. `docs/phase-4-live-test.md` links the raw room and
GitHub snapshots. No autonomous worker claim is made: provider accounts
remained unavailable, so Codex prepared code and scripted claims under the
worker bot identities after disclosing that in-room and in PR receipts.

The first receipt update attempt was interrupted; a retry through `gh pr
edit` failed on a deprecated Projects Classic GraphQL field. GitHub REST
updated the body. Two premature `receipt_ok` ledger entries were called out
with a later error event; only the later `validated: true` event marks the
confirmed body. Gate code now refuses the second negotiated merge until the
first has merged, a validated post-rebase receipt exists, and the branch is
based on current main. Its refusal path has an offline test.

## Phase 5 — deterministic 9 AM report (2026-11-06)

The ledger now has a formal shared boundary in `supervisor/src/ledger.ts`.
Every writer appends one JSON object per line and never rewrites history;
readers count malformed lines, accept both legacy task records and typed
events, and select the window after the last `report_posted`. New task records
persist their assigned worker so future trust rows are attributable without
consulting mutable room history.

`report.ts` folds that window into a stable Markdown report containing linked
merges, rollback reasons, blocks, needs-eyes gaps, per-worker completion,
rollback, average budget and trust statistics, plus one recommendation. The
formula is printed in the report. `clock.ts` runs it at local 09:00 and
recomputes the next date after every run. The same publisher backs the
`supervisor report` CLI and addressed `shift report please` room command.
Repeated same-day triggers with no intervening events reuse the existing
artifact and do not post or append twice.

The live room rehearsal ran against all four services. Post
`rxuq39ndzbyyiyacqyczufa3xe` requested the report; supervisor post
`bacafydjcinn7d3t369owmkfuo` returned 3 merged links, 1 rollback reason,
0 blocked, 0 needs-eyes, a 70/100 aggregate historical trust row, and the
rollback recommendation. The ledger recorded 20 consumed events and the
room trigger. An immediate CLI call reused the artifact. Because phases 2–4
did not store worker names in task records, those five live attempts are
reported as `unassigned`; inventing attribution would break deterministic
ledger-only replay. The new field fixes this prospectively.

The Phase 5 tests add an exact golden fixture, byte-preserving append and
report-window checks, publisher idempotency, local 09:00 calculation, and a
25 ms accelerated first run. `scripts/p5-checks.mjs` then builds a scratch
clone and proves its replay matches the same golden file. The complete
supervisor suite is 101/101. Live evidence is in
`docs/phase-5-live-test.md` and `docs/phase-5-room-transcript.json`.

## Phase 6 — demo day and reproducible handoff (2026-11-06)

The fresh-clone audit found an important packaging gap before any demo work:
the outer repository ignored all of `ops/` and the nested target, so a judge
could not execute the documented stack. The fix keeps secrets and generated
agent state ignored while tracking the pinned Switch 0.31.0 Compose contract
and blank environment example. `scripts/bootstrap.sh` clones the separate
target repository, installs locked dependencies, builds the supervisor, and
generates a chmod-600 `ops/.env` without replacing an existing environment.

`demo/night.yml` declares exactly three bounded outcomes: merge, rollback,
and deliberate collision. `demo/run.mjs` validates that schema, creates an
isolated local remote from target main, runs the actual target test suite on
all three branches, renders and validates production receipts, checks the
production gate table, detects overlap from the actual branch diffs, parses
two worker claims, forces the promised Git rebase conflict, resolves it in
the agreed order, re-tests, and renders the ledger-derived report. No public
PR or production ledger is mutated. Offline completion took 4.5 seconds.

The live Switch rehearsal took 5.8 seconds. Ten room posts, all prefixed
`[scripted demo]`, show the goal, three clean receipts, collision and order,
merge, rollback reason, rebase/retest merge, and final 2/1 report. Raw evidence
is in `docs/phase-6-room-transcript.json`; interpretation and limits are in
`docs/phase-6-live-test.md`. Demo PR numbers are identifiers, not GitHub PRs,
and no autonomous worker-reasoning claim is made.

The new root README leads with the real trust problem, includes the Mermaid
architecture, clone-to-demo quickstart, receipts and gate rules, Switch's
non-optional role, evidence, and honest limitations. `docs/demo-shotlist.md`
maps a 3–4 minute recording to the four judging dimensions and names the
primary Best Business Workflow track, optional side-track rule, required
repo/video/README artifacts, secret checks, and the November 7 23:59 IST
deadline. `scripts/p6-checks.mjs` lints those promises and the demo schema.

Fresh-clone smoke used commit `3c87aad` in an isolated directory. Bootstrap
cloned the target, installed dependencies, built cleanly, and created a new
secret environment; the offline demo finished in 5.8 seconds. To avoid a
second Compose project colliding on the same four host ports, the final
verifier in that clone was pointed at the already-running stack using its
local ignored credentials. It passed every phase, both clean-worktree checks,
and the final `ALL ... verify passed (offline)` line. The documented Compose
`up -d --wait` command was also rerun directly and all service conditions
completed successfully.
