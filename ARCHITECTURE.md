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
phase actually builds them. *(Last updated: end of phase 1.)*

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
- `rehearsal.md` — the phase-1 exit checklist, plus the transcript in
  `docs/rehearsal-transcript.md`; run it on any fresh install before any
  phase beyond 1.

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
CI green (phase 3), referees worker file collisions (phase 4), and renders
the 9 AM shift report from `supervisor/ledger.jsonl` (phase 5). Its only
runtime dependencies are Node's own WebSocket/fetch/fs. Delete it and
taskslips pile up unread: nothing merges, nothing is blocked, no report at
9 AM.

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

## scripts/verify.sh (built phase 0, grows every phase)

The always-green contract: every check prints labeled PASS/FAIL, offline
mode runs with zero AI calls and zero flaky networks, `--live` optionally
exercises the real stack. Night Shift never commits, and never builds, on a
red base. Since phase 1 it also runs `scripts/p1-checks.mjs`: the crew SOP
must literally parse (no YAML library — the template keys, the room roster,
the kickoff), the schemas must state their contracts, and the three crew
agents must exist, admin-owned, with the template's addressing rules.
Delete it and nobody can ever again prove the phases keep working.

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
