# Night Shift — Phase Execution Plan

Companion to `docs/SPEC.md`. One controlled plan per phase, executed one
phase at a time, tagged `phase/<n>`, ending green. Confidence sources:
fetched docs (2026-11-02) + shallow clone of sandbox-quantum/switch.

Day budget: hackathon Nov 4–7, 2026 (deadline Nov 7 23:59 IST). Plan targets
having P0–P2 done before the event, P3–P5 during, P6 last day buffer.

---

## Today (Nov 2) — spec + P0 + P1 if possible

### P0 — workspace + live smoke test (~90–120 min)

Steps (each = one commit unless noted "no commit"):

0.1 Scaffold monorepo skeleton (commit 1)
- mkdir crew supervisor target docs scripts + target/ later as nested repo
- ARCHITECTURE.md skeleton: one paragraph per planned component (from SPEC §2)
- PROJECT_LOG.md initialized with a Pre-Phase 0 section (spec written,
  docs deltas: WS-not-SSE, no reaction events, provider list) — keeps "empty"
  honest-true going forward
- .gitignore: target/ (nested repo), ops/.env, supervisor/.env, node_modules,
  .DS_Store; git init; first commit; tag is NOT cut yet (phase tag comes
  after green)

0.2 target/ petshop (commit 2, separate git repo inside)
- npm init; add express; src/index.js mounts routes; src/routes/pets.js,
  src/pagination.js, src/seed.js
- 6+ node:test tests hitting the app in-process (no extra deps)
- BACKLOG.md with the 6 items from SPEC §5.1 (items 5/6 curated for P4 collision)
- README.md (crew flow, main "protected in spirit", branch naming)
- .github/workflows/ci.yml (node 22, push+PR); push to GitHub repo
  `shashwat558/nightshift-target` (create with gh); verify Actions green

0.3 Switch up (no commit until P0 exit)
- Fetch latest GHCR standalone-compose tag (oras or GHCR API); pin
  SWITCH_VERSION in ops/.env
- Generate secrets via the generator model (openssl rand), write ops/.env
  with FEATURE_FLAGS_ENABLED=agent_management + CONTROLLER_TOKEN_SECRET
- `docker compose -f deploy/local/standalone-docker-compose.yml --profile
  collab --profile gateway up -d` (compose file vendored into ops/ per
  version, recorded in PROJECT_LOG; pull the artifact from GHCR per docs)
- Wait healthy; curl GET /health (bridge/API base probe) + gateway login page

0.4 Console + first agent (P0's Phase-critical proof)
- Install Switch Console Linux build if available; else run server via
  Docker (per docs) and record — Console instability expected per prompt
- Add server (local run mode), sign into Mattermost
  (MATTERMOST_USER from .env), create room `shift-hangar` in Mattermost
- Create the Switch-expert agent via the built-in template; @-mention it in
  shift-hangar; agent must post `Night Shift ground check complete`
- If any step impossible: diagnose in PROJECT_LOG, hard rule 7 halt signal

0.5 Tooling checks (existence only, never print secrets): gh auth, git
identity, provider status (claude absent checked already; opencode signed
in), docker healthy

0.6 scripts/verify.sh v1 (commit 3): the P0 offline line list from SPEC §5.4
+ conditional stack-up lines (already-up case). Run `--offline`; show output.

0.7 ARCHITECTURE.md + PROJECT_LOG.md updates; commit; tag `phase/0`

P0 exit: room reachable ×3 (API read, Mattermost UI login, agent posted),
verify.sh offline green, Actions workflow green on target repo.

### P1 — crew template (~60–90 min)

1.1 Write crew/taskslip.schema.md + crew/receipt.schema.md (SPEC §4.1/.2)
    + crew/rehearsal.md checklist
1.2 crew/nightshift.template.yaml per TEMPLATES.md v1 (params/agents/room/
    kickoff; addressing exact per SPEC §3; kickoffs make three distinct
    greetings with one-line jobs)
1.3 Apply template per docs: Console Templates → Import template → run
    (falling back to asking our own agent to run_template if Console UI
    unstable — recorded); confirm agents exist and joined overnight-crew
1.4 rehearsal.md run-through: addressing rules demonstrated & screenshots
    into docs/ (“night-lead answers when addressed by human; workers silent;
    each picks its own words”)
1.5 verify.sh adds: schema files parse, template YAML has required keys,
    rehearsal doc present; run offline; commit; tag `phase/1`

P1 exit: three distinct agents in room logs; addressing demonstrably OBEYED
(screenshots); no crashes; verify green.

### P2 — goal in, PR out (~3–4 h) — *first sub-4* Nov 3

2.1 supervisor/ layout from SPEC §5.3, TypeScript, tsc dev-only, Node 22
    globals (WebSocket, fetch); register agent once, store key chmod 600
2.2 switchclient.ts + listener.ts: WS connect (scope=all, filter=all),
    pong every ping before dispatch, act only on payload.addressed,
    reconnect on heartbeat_lapsed, stop on taken_over (unit
    test: fake server frames)
2.3 goals.ts: `tonight:` → post @night-lead request → watch
    crew/taskslips/<date>.yml (fs.watch recursive + 1s poll fallback) with
    2-phase timeout → slips.ts parse (tiny strict parser)
2.4 spawner.ts: provider adapter (opencode headless by default, claude -p
    option) — git -C target checkout -b shift/<task-id> from origin/main →
    run provider in cwd with slip text + receipt requirements → collect
    diff main…HEAD + test output; budget kill-switch
2.5 prs.ts: gh pr create --draft with receipts block (§4.2); CI status read
2.6 Room post: task id, branch, PR link, summary one-liner, PASS/FAIL
2.7 verify.sh: synthetic goal → exactly one slips file w/ required fields;
    synthetic worker receipt → PR body render check; run both OFFLINE with
    the parser + renderer unit-tested (no AI calls)
2.8 Live test: real `tonight: implement BACKLOG item 1` → real PR + room
    post; screenshot to docs/; ARCHITECTURE supervisor loop paragraph;
    commit; tag `phase/2`

P2 exit: one real live loop, green receipts, room post, verify offline green.

### P3 — trust gates (~2–3 h) — Nov 3–4

3.1 gates.ts: receipt validation vs schema → missing ⇒ needs-eyes post
    naming exact gaps; gate command grammar from SPEC §4.4; approve honored
    only after CI green; rollback = gh revert PR + record + room post
    "rolled back: <reason>"; hold = needs-eyes
3.2 budgeted night: process up to N slips sequentially; per-slip timer; on
    timeout kill spawner, block with reason, continue
3.3 docs/ reaction-command manual (in-room doc + repo docs/); rehearsal of
    all three outcomes with BACKLOG 1–3 curated
3.4 verify.sh: gate logic unit tests (approve-without-CI rejected; missing
    field needs-eyes; budget block); commit; tag `phase/3`

P3 exit: all three outcomes live+visible; verify green.

### P4 — conflict negotiation (~2 h) — Nov 5

4.1 negotiation.ts: overlap detection via git diff --name-only between
    open PRs; open negotiation thread; per SPEC §4.4 rounds; sanity-check
    claims vs actual diff; consistency ⇒ ordered landing (merge first, then
    second rebases, re-tests, posts updated receipt, merges);
    contradiction ⇒ escalate with side-by-side
4.2 BACKLOG items 5+6 collide on src/index.js by design
4.3 Live demo run capturing negotiation + landing order
4.4 verify.sh: fixture diff overlap scanner; orderer state machine tests;
    commit; tag `phase/4`

P4 exit: room-thread negotiation visible; both PRs land in agreed order.

### P5 — 9 AM report (~2 h) — Nov 6

5.1 ledger.ts append-only (exists already since P2 — now formalized)
5.2 report.ts builder: merged (count+links), rolled back+, blocked+,
    needs-eyes+, per-worker stats (done/rollback/budget avg/trust score),
    one "tonight's recommendation" line
5.3 triggers: internal clock module 09:00 daily, `supervisor report` CLI,
    room phrase `shift report please`
5.4 verify.sh: replay fixture ledger → golden report match + scratch-clone
    replay; commit; tag `phase/5`

P5 exit: accelerated run → correct report; fixture replay deterministic.

### P6 — demo day (~2–3 h) — Nov 6 late / Nov 7 morning

6.1 demo/night.yml scripted accelerated night (goal → 3 slips: merge,
    rollback, deliberate collision) running end-to-end <10 min
6.2 README for judges (pain in 2 sentences, mermaid architecture, quickstart
    clone→docker→configure→run demo/night.yml, receipts/gates explainer,
    "what Switch does here" section, honest limitations)
6.3 docs/demo-shotlist.md (rubric-mapped shots + submission checklist:
    tracks/categories, deadline Nov 7 23:59 IST)
6.4 Fresh-clone smoke test: replay README quickstart from scratch clone;
    verify.sh full; final PROJECT_LOG; commit; tag `phase/6`

P6 exit: fresh-clone works; verify green; submission materials ready.

---

## Standing rules of engagement while executing

- No commit without verify.sh offline green in the same session.
- Broken state ⇒ diagnosing note in PROJECT_LOG, then STOP and report.
- Every verification line pasted verbatim into chat when claiming PASS.
- Unknown-to-spec Switch behavior discovered mid-phase ⇒ PROJECT_LOG
  "deltas" section first, then continue or stop.
- Requests for anything outside the current phase go to PROJECT_LOG, never
  built silently.

## Worktree etiquette

- Outer monorepo: main protected in spirit, feature branches per phase,
  tag phase/<n> per phase, linear history.
- Nested target/ repo: the crew's playground; supervisor is its only
  automated committer besides GitHub Actions CI runs' merge events.
- Secrets: ops/.env & supervisor/.env git-ignored, chmod 600.
