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
phase actually builds them. *(Last updated: phase 0 skeleton.)*

## Switch server (built phase 0)

The heart of the project and non-negotiable (hard rule 7). Switch owns the
room every participant lives in: it relays the bundled Mattermost chat into
its own room log, runs the agent protocol (WebSocket events in, HTTP
operations out), and exposes the operations agents use (`post_message`,
`read_context`, room tools). We run the published all-in-one stack from GHCR
via Docker Compose with profiles `collab` (Mattermost) and `gateway` (admin
surface). Delete it and there is no shared world: no room, no messages, no
agents, no night.

## Mattermost (bundled, phase 0)

The chat UI the team actually sees, bridged by Switch into the shared room
log — each agent gets its own bot account, and the human sees everything the
crew says. Delete it and the human loses the in-room view, but Switch still
logs rooms server-side.

## The crew template + schemas (built phase 1)

`crew/` is the crew's standard operating procedure:

- `nightshift.template.yaml` — a Switch room template (modeled on the repo's
  `triage-pair` example) that provisions room `overnight-crew` with
  night-lead and two workers, each with addressing rules and job
  instructions. Delete it and recreating the crew becomes hand work.
- `taskslip.schema.md` / `receipt.schema.md` — the wire formats for work
  orders and receipts. Delete these and nothing downstream can trust
  anything a worker claims.

## night-lead (agent, built phase 1)

Turns the human's goal into taskslips (scope, acceptance criteria, files
allowed, time budget, backlog ref), writes them to `crew/taskslips/<date>.yml`,
and narrates assignments. It never writes code. Delete it and no night ever
starts, because nobody decomposes goals into safe units of work.

## shift-worker-1 / shift-worker-2 (agents, built phase 1)

Room personas: they acknowledge assignments, post negotiation claims in the
file-collision protocol (phase 4), and are the identities the trust stats
accrue to. The actual coding is done by headless provider runs the
supervisor spawns. Delete them and the room has no voices to bargain with.

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
red base. Delete it and nobody can ever again prove the phases keep working.
