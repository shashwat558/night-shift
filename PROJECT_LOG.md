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
