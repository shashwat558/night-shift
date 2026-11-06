# Night Shift — Project Spec

Status: **pre-phase spec** (written before Phase 0 scaffolding, exactly as
requested on 2026-11-02). Nothing here is a claim: every statement about how
Switch behaves is sourced from https://docs.switchagents.ai/ fetched on
2026-11-02 (listed in Appendix A). Phase 0 must re-verify all ASSERT tags.

Night Shift is an overnight crew of AI coding agents that works in a Switch
chat room like real teammates. A human posts tonight's goal in the room. A
night-lead agent turns it into small, strictly scoped work orders called
**taskslips**. Worker agents take one taskslip at a time, work on their own
branch, and open a PR with a **receipts** block (what changed, test output
with raw logs, risk call, scope deviations). A shift-supervisor validates
receipts, enforces CI, and gates every merge behind human sign-off in the
room. If two PRs touch the same files, the two workers negotiate a rebase
order in the room, in the open. At 9 AM the supervisor posts a shift report.
Switch is the heart of this: the room, its shared log and the agent protocol
are not optional.

---

## 1. Judging alignment (Flip the Switch, WeMakeDevs x Switch, Nov 4–7 2026)

| Rubric line | How Night Shift answers it |
| --- | --- |
| Switch is central, never a wrapper | The room IS the comms bus; agents registered/connected through Switch's agent protocol (WS in, HTTP out); taskslips, receipts, gate decisions, negotiations all live in the room; the ledger is a replay of what the room says. No Slack/Discord/webhook bypass. |
| Everything actually running + reproducible | Pinned `SWITCH_VERSION` compose stack from GHCR; `scripts/verify.sh --offline` runs green with zero AI calls; `demo/night.yml` runs a whole scripted night in <10 min; README quickstart is fresh-clone followable. |
| A real team problem | Real pitfall: unattended agent work overnight — PRs nobody reviewed, no receipts, no one to merge. Night Shift's receipts + human gates make overnight unattended agent work safe to merge in the morning. (Story for README.) |
| Demo presentation | P6: scripted demo, shot list mapped to rubric, recording checklist, honest limitations section. |

## 2. The one diagram

```
human (Mattermost, bundled)
   │  "tonight: ..." / "@shift-supervisor approve B-3"
   ▼
Switch server (docker: switch-core :8000, gateway :3000, postgres, mattermost :8065)
   │  agent protocol: WebSocket events in, HTTP ops out
   ├── @night-lead        Cruise-created room agent (provider-backed) → crew/taskslips/<date>.yml
   ├── @shift-worker-1    room persona; acks, negotiation claims
   ├── @shift-worker-2    room persona; acks, negotiation claims
   └── shift-supervisor   OUR AGENT (Node 20+TS, zero/minimal deps)
        register POST /agents → update_agent_detail(addressing) →
        WS /agents/{id}/connection/ws (ping/pong, cursor) →
        on addressed "tonight:" → ask night-lead → watch crew/taskslips/<date>.yml →
        spawn headless coder in target/ on branch shift/<task-id> →
        git diff main + test output → gh pr create (draft, receipts block) →
        post_message to room → gate on human command + CI green → merge/rollback/hold →
        ledger.jsonl → 9 AM shift report
```

How it talks to the other parts, one sentence each:

- **Switch server** owns the room and every message. Delete it → nothing exists; the crew has no shared world.
- **Mattermost** is the UI Switch bridges; deleting it removes the human's view but Switch rooms still log.
- **night-lead** is the only agent that decomposes goals; deleting it → no taskslips → night never starts.
- **workers (room personas)** say acks, negotiation claims, and are the faces trust stats accrue to; deleting them → supervisor still runs but nothing in the room represents a worker.
- **headless coder runs** are `claude -p`/`opencode run` child processes in `target/`; deleting them → no code, no PRs, receipts impossible.
- **shift-supervisor** is the machine the night runs on; deleting it → taskslips pile up unread, nothing merges, no report.
- **target/** is the simulated company repo (its own git repo, main protected "in spirit"); deleting it → crew has no work product.
- **crew/** is the SOP (template, schemas, rehearsal); deleting it → agents lose their job descriptions and the wire format of slips/receipts.
- **ledger.jsonl** is machine truth; deleting it → no 9 AM report, no trust stats, no replay in verify.sh.
- **verify.sh** is the always-green contract; deleting it → nobody can prove phases stay working.

## 3. Party roster

| Who | Where it lives | Addressing | Behaves |
| --- | --- | --- | --- |
| human (shashwat) | Mattermost user `{$creator}` | — | posts goal; issues gate commands |
| night-lead | template agent `nightshift-night-lead` | `anyone` | goal → taskslips file; never writes code; narrates |
| shift-worker-1 | template agent `nightshift-worker-1` | `owner-agents` | acks assignment; negotiates claim (P4); no code |
| shift-worker-2 | template agent `nightshift-worker-2` | `owner-agents` | same |
| shift-supervisor | our registered protocol agent `shift-supervisor` | `anyone` (needs human talk) | everything mechanical; gates money-moves |
| headless coder | child process (`provider run -p`) in `target/` on `shift/<task-id>` | no presence | codes, writes nothing to the room |

Naming: identifiers must match `^[a-z0-9][a-z0-9._-]*$` (server rule). The
template prefixes all names with a `team` param, default `nightshift`, with
the display names reading Night Shift Night Lead etc. The supervisor is
registered directly as `shift-supervisor`.

## 4. Data contracts

### 4.1 crew/taskslip.schema.md → taskslip (written to crew/taskslips/<date>.yml)

Exactly one YAML-list doc of slips. Fields (all required unless noted):

```yaml
 slips:
  - id: B-20261102-01        # <backlog-ref>-<date>-<seq> ; branch is shift/<id>
    backlog_ref: BACKLOG-1   # line in target/BACKLOG.md this implements
    title: Add input validation to POST /pets
    assignee: shift-worker-1 # rotate by round-robin
    scope: what to do, in <= 3 sentences
    files_allowed:           # hard whitelist, relative to target/
      - src/routes/pets.ts
    acceptance:              # testable criteria, one line each
      - POST /pets with empty name returns 400
    time_budget_minutes: 20  # wall clock; supervisor enforces
    notes: optional          # why this matters, gotchas
```

Worker code never touches a file outside `files_allowed`; deviations go in
the receipt's `deviations` (deck filed under honesty, not silence).

### 4.2 crew/receipt.schema.md → receipt (the PR "receipts" block)

```markdown
#### receipts — <task-id>
- summary: one line what changed
- files-touched: comma list | "none outside files_allowed"
- tests: PASS | FAIL
- test-log: fenced block, RAW tail of the runner output (no paraphrase)
- risk-call: low | medium | high — one sentence why
- deviations: none | bullet list of every step outside the slip
- budget: <spent> / <budget> min
```

Missing or incomplete ⇒ PR is gate-blocked `needs-eyes` with a room post
naming exactly what is missing (P3). A receipt can never merge with FAIL.

### 4.3 supervisor/ledger.jsonl (machine truth; room is the human view)

One JSON object per event, appended, never rewritten:

```json
{"ts":"2026-11-03T03:14:05Z","actor":"shift-supervisor","type":"goal_received","refs":{"room":"overnight-crew","message_id":"m-123"},"note":"tonight: BACKLOG 1-4"}
{"ts":"...","actor":"night-lead","type":"taskslips_written","refs":{"file":"crew/taskslips/2026-11-03.yml","slips":["B-...-01","B-...-02"]}}
{"ts":"...","actor":"shift-supervisor","type":"assignment","refs":{"task":"B-...-01","worker":"shift-worker-1","spawner":"opencode"}}
{"ts":"...","actor":"shift-supervisor","type":"pr_opened","refs":{"task":"B-...-01","pr":42,"branch":"shift/B-...-01"}}
{"ts":"...","actor":"shift-supervisor","type":"gate_result","refs":{"task":"B-...-01","gate":"approved","by":"shashwat","ci":"green"}}
{"ts":"...","actor":"shift-supervisor","type":"merge","refs":{"task":"B-...-01","pr":42}}
{"ts":"...","actor":"shift-supervisor","type":"rollback","refs":{"task":"B-...-02","reason":"worker touched auth file"}}
{"ts":"...","actor":"shift-supervisor","type":"block","refs":{"task":"B-...-03","why":"budget 20min exceeded at 21min, tests red"}}
{"ts":"...","actor":"shift-supervisor","type":"negotiation","refs":{"task":"B-...-04","opponent":"B-...-05","agreed_order":["B-...-04","B-...-05"]}}
{"ts":"...","actor":"shift-supervisor","type":"report_posted","refs":{"file":"docs/reports/2026-11-03.md"}}
```

`type` ∈ {goal_received, taskslips_written, assignment, worker_started,
worker_finished, pr_opened, receipt_ok, needs_eyes, gate_result, merge,
rollback, block, negotiation, negotiation_result, report_posted, error}.
Phase 7 also appends `policy_result` and `review_result`, each bound to the PR
head SHA and evidence fingerprint.

### 4.4 Room message grammar (the whole crew speaks these)

- Goal:     any message from the human starting with `tonight:` → supervisor.
- Gate:     `@shift-supervisor approve <task-id>` / `rollback <task-id>`
            / `hold <task-id>`. approve counts only when the task's PR has
            CI green at read time; anything else → supervisor replies with
            the refusal and the current CI state. (P3)
- Report:   `@shift-supervisor shift report please` (P5, on demand).
- Assignment narration: supervisor posts `@night-lead …` for slips, then
  `@shift-worker-N: take <task-id>` for acks (P2).
- Negotiation: supervisor opens `@shift-worker-1 @shift-worker-2 file-collision
  on <path> — state your claim, ≤3 lines, round 1/2` and each posts exactly
  one claim per round, then a decision post (P4).

**Docs delta (recorded, actioned):** the plan suggested emoji reactions
(✅/♻️/👀) as the trigger. Fetched docs show the agent protocol has NO
reaction events and NO reaction operations — Mattermost reactions exist only
as the bridge's own "working/queued" marks; human reactions do not reach
agents. Rather than poll Mattermost around Switch (forbidden by hard rule 7),
gates run on the typed commands above. Humans may still drop the matching
emoji on the supervisor's post for the visual; the typed command is the
machine truth and the ledger records it. If Switch ships reaction events
during the hackathon, we switch and record it.

## 5. Components, with their exact Stripe-of-truth

### 5.1 target/ (petshop service — its own git repo)

- Node + Express; endpoints: `GET /health`, `GET /pets` (list, paginated,
  seeded data), `POST /pets` (create), `GET /pets/:id`. Tests with
  `node:test`/`supertest`-free style via `fetch` against `listen()` — 6+
  tests, all green at P0.
- CI: `.github/workflows/ci.yml`, node 22, `npm ci && npm test` on push and
  pull_request to main. Judge sees green runs on real PRs from the night.
- `BACKLOG.md`: exactly the small pointed tasks below; each names its
  headline touch file so P4's collision is stageable:
  1. add input validation to POST /pets (4xx on empty/long name) — `src/routes/pets.js`
  2. add 404 branch + friendly body to GET /pets/:id — `src/routes/pets.js`  ← collides with 1
  3. fix off-by-one in GET /pets pagination (page/limit) — `src/pagination.js`
  4. add retry w/ backoff to the seed-loader's transient failure path — `src/seed.js`
  5. (P4 curated collision pair) tiny endpoint `GET /stats` — `src/routes/stats.js` + `src/index.js`
     (pairs with item 6 which also edits `src/index.js`)
  6. (P4 curated collision pair) mount a tiny `/version` endpoint — `src/index.js` + `README.md`
- README explains: main protected in spirit — merges only by supervisor with
  human sign-off; branches `shift/<task-id>`; no direct pushes.

### 5.2 crew/ (the SOP)

- `nightshift.template.yaml` — Switch room template. Modelled on the repo's
  `examples/agent-templates/triage-pair.template.yaml` (fetched via shallow
  clone of sandbox-quantum/switch). Shape:
  - `params: team (string), provider (provider chain [claude…, opencode]),
    location: local, directory, bridge [Mattermost, $first]`
  - `agents:` night-lead (`addressing: anyone`), worker-1 and worker-2
    (`addressing: owner-agents`), each `provider: "{provider}"`,
    `location: "{location}"`, `directory: "{directory}"` — night-lead's
    directory = this repo root (it reads crew schemas, writes crew/taskslips);
    workers' = repo root too for claims (they never code).
  - `room:` name `overnight-crew`, `bridge: "{bridge}"`,
    `agents: [...]`, `users: ["{$creator}"]`, instructions pointing crews to
    the message grammar in §4.4.
  - `kickoff:` greeting script that makes night-lead and both workers greet
    distinctly (name + one-line job each).
- `taskslip.schema.md` and `receipt.schema.md` — as §4.1/§4.2 with examples.

### 5.3 supervisor/ (our protocol agent — Node 20+, TypeScript, minimal deps)

Layout:

```
supervisor/
  package.json         (type module, tsc, zero runtime deps)
  tsconfig.json        (ES2022, NodeNext)
  src/
    env.ts             (config: API_BASE, AGENT_API_KEY, ROOM, TARGET, …)
    switchclient.ts    (register/once, update_agent_detail, WS connect+
                        reconnect+cursor+pong, ops calls, post_message)
    listener.ts        (event loop: connect → read frames → dispatch)
    goals.ts           (tonight: → nudge night-lead → wait for slips file)
    slips.ts           (parse crew/taskslips/<date>.yml — tiny strict parser)
    spawner.ts         (headless provider run in target/; branch mgmt)
    prs.ts             (gh pr create --draft; receipts block; CI status)
    gates.ts           (approve/rollback/hold; CI green check; merge)
    negotiation.ts     (overlap diff scan, rounds, ordered landing)
    ledger.ts          (append-only jsonl)
    report.ts          (9 AM builder + renderer; fixture replay for tests)
    clock.ts           (internal scheduler; no cron lib; 09:00 trigger)
    main.ts            (wire everything; run under systemd/nohup or tmux)
  test/ (offline unit tests: slips parser, receipt render, gate logic,
         report render from fixture ledger)
```

- **No runtime npm deps.** Node 22 (installed here: v22.23.2) ships global
  `WebSocket`/`fetch`/`fs.watch`; the TypeScript toolchain (build-time only:
  `typescript`) is the single devDependency.
- API surface (all at the **agent bridge base**, NOT the gateway):
  `GET /health` (public probe), `POST /agents` (once, registration key as
  bearer, body shape from agent-protocol doc), `POST
  /agents/{id}/ops/update_agent_detail` `{agent_id, addressing:"anyone"}`,
  `GET /agents/{id}/connection/ws?connection_id=<uuid>&rooms=<id>&scope=all&filter=all&start_from=head`
  (+ `Authorization: Bearer` agent key), answer every 2s `ping` with
  `{"type":"pong","cursor":<highest seq>}` before processing events, resume
  with `start_from` + `expected_generation`, stop on `evicted.code ==
  taken_over`. Operate on `message` events only when `payload.addressed` ==
  true. Post via `POST /agents/{id}/message {room_id, content}` (no
  connection needed) or the `post_message` op with the connection-id header.
- **Doc delta (recorded):** hypothesis said "SSE in, HTTP out". Live docs:
  WebSocket is the current transport; SSE is deprecated ("removed after a
  transition period"). We build WebSocket-only and note it.

### 5.4 scripts/verify.sh

Bash. Labeled PASS/FAIL each line, `--offline` default, `--live` add-on,
exit 1 on first FAIL. Checks grow with the product (exact mapping below):

| Phase | offline additions |
| --- | --- |
| 0 | node ≥20, git identity set, `gh auth status` ok (existence only), docker healthy, switch core health endpoint reachable if stack up, mattermost reachable, room list API read, provider key existence check (never prints values), target tests green |
| 1 | crew schema files exist + parse; template YAML valid per TEMPLATES.md keys; registered crew and addressing rules verified |
| 2 | synthetic goal → slips parser produces ≥1 valid slip; fake worker receipt → PR body render contains summary/tests/risk sections |
| 3 | gate logic table (approve-without-CI rejected; rollback path; missing-receipt→needs-eyes) as unit tests; budget logic state machine |
| 4 | overlap scanner: fixture branch diffs → detected shared file; negotiation orderer: claims consistent→executes, contradictory→escalate |
| 5 | fixture ledger → rendered report matches golden file; ledger append-only check; scratch-clone replay test |
| 6 | README quickstart commands lint; demo/night.yml schema lint; submission checklist present |

Everything offline stays deterministic: fixtures, no clock/network beyond
localhost checks that degrade gracefully if the stack is down (those
particular lines SKIP-marked, but P0's green baseline requires the stack).

## 6. Environment contract

- Ports: switch-core :8000, gateway :3000, mattermost :8065, postgres :5432
  (compose-internal), target dev :3001 in demo runs (avoid :3000 clash).
- `ops/.env` (git-ignored, generated with
  `deploy/local/generate-env-secrets.sh` model from the switch repo):
  SWITCH_VERSION=<pinned tag>, AGENT_REGISTRATION_TOKEN, SECRET_KEYS,
  GATEWAY_ADMIN_EMAIL/PASSWORD, MATTERMOST_ADMIN_* / MATTERMOST_USER_*.
  `FEATURE_FLAGS_ENABLED=agent_management` + `CONTROLLER_TOKEN_SECRET=<32+>
  hex` for the crew template to create managed agents.
- supervisor/.env (git-ignored): SWITCH_API (http://localhost:8000),
  SWITCH_AGENT_KEY (registered once, stored chmod 600), SWITCH_ROOM=
  overnight-crew, TARGET_REPO=../target, GH_REPO (from git remote),
  WORKER_PROVIDER=claude|opencode.
- Secrets never printed; every check prints `[set]`/`[missing]` only.

## 7. Hard rules → concrete enforcement

1. Phase discipline: each phase maps to one branch/commit set + tag
   `phase/<n>`; out-of-scope ideas go to PROJECT_LOG.md backlog section.
2. Always-green: `scripts/verify.sh --offline` before every commit; red ⇒
   diagnose (or open a PROJECT_LOG gap entry) and stop; never build on red.
3. Docs as the product: ARCHITECTURE.md grows; every phase ends with a dated
   PROJECT_LOG.md entry (built / verification output / known gaps).
4. Truth over optimism: every PASS line is executed, output pasted into the
   reply; receipts contain raw logs cut from real runs; demo numbers come
   from ledger.jsonl only.
5. Docs win: ASSERT tags in this spec are re-verified at P0; deltas are
   appended to a docs/deltas section of PROJECT_LOG.md (first three already
   captured: WS-not-SSE, no reaction events, template language v1 exact).
6. One meaningful commit per step; phase tag on completion.
7. If Switch/Mattermost/provider unusable → halt with diagnosis; no bypass.

## 8. Risks and mitigations (ranked)

| # | Risk | Likelihood | Mitigation |
| --- | --- | --- | --- |
| 1 | Switch Console unusable on Linux | real | Canonical path per docs: standalone GHCR compose up `--profile collab --profile gateway`; Console added later only as a client if it installs. Agents for the crew template need Console DIRECTLY on supported Linux in this early-access build; fallback: register the three crew agents as protocol agents ourselves ONLY after posting the diagnosis and getting consent, or run Console under Docker/x264 AppImage. Phase 0 exit criterion requires an agent answering either way; if impossible, hard rule 7 halt. |
| 2 | `claude` CLI absent | real (checked) | Stack line says `claude -p`, provider chain docs allow opencode; machine has opencode 1.19.4. Spawner abstracts provider behind one interface; run headless `opencode run` unless user installs claude. Recorded in PROJECT_LOG as a delta + question. |
| 3 | agent management flag needed for template-created agents | medium | Set flag + CONTROLLER_TOKEN_SECRET in .env from P0 (checked BEFORE P1), record in log. |
| 4 | Worker spawner quality/timeouts | medium | Budget timeouts at supervisor level (kill → mark blocked w/ reason, continue); receipts validated on claw-back; retries only human-approved. |
| 5 | Race: night-lead writes slips file late | low | Watcher with generous timeout + `@night-lead` re-nudge once at 60s; then block with reason (never fake slips). |
| 6 | GitHub PR CI flaky/slow on free tier | low | Gate reads `gh pr checks --watch`-with-timeout; approve honored only on green; else reply with pending state. |
| 7 | Two-phase typing: template address rules vs. announced party names | low | Live room transcript confirms each addressing case (night-lead answers anyone; workers stay silent unless owner-agents). |
| 8 | Nest git repo (target/) inside monorepo | low | `.gitignore` `target/` in outer repo; SUP stands on `git -C target`; documented in both READMEs. |

## 9. Decisions (answered by the human 2026-11-02)

D1. Worker spawner default = **headless opencode** (`opencode run`),
provider-abstracted so `claude -p` can drop in later without changing the
supervisor's contract.

D2. Scheduling (P5) = **tiny built-in clock module** in supervisor; no
node-cron dependency.

D3. Slip-file parsing = **tiny built-in parser** for the flat YAML subset;
no js-yaml dependency.

## Appendix A — Doc sources fetched 2026-11-02 (docs switchagents.ai)

- Switch quickstart (Console flow; environment needs Docker + signed-in agent CLI)
- Agent protocol (registration POST /agents, integration_profile, addressing
  ops, WS connect, ops catalog, `post_message`/`POST /agents/{id}/message`)
- Agent connection (WS frames, ping every 2s, cursor/generation, eviction
  codes incl. taken_over, connection outlives socket, SSE deprecation)
- Agent events (message/command/room_join payloads, `payload.addressed`,
  participant id shapes, rooms-as-logs ordering, buffer semantics)
- Room templates (template language v1/v2 — params, agent block incl.
  addressing enum [owner | owner-agents | anyone], room block, kickoff, runs)
- Self-host (GHCR standalone-compose artifact, profiles collab/gateway,
  required env, pinning versions, agent management feature flag)
- Repo examples: `examples/agent-templates/triage-pair.template.yaml`,
  `examples/room-templates/red-blue-workroom.template.yaml` (shallow-cloned
  from sandbox-quantum/switch for exact shapes)
- Mattermost bridge internals (bundled Mattermost via profile `collab`;
  reactions are outbound marks only ⇒ gate delta in §4.4)
