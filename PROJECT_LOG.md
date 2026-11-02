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
