# Rehearsal — phase-1 exit checklist (run before tagging phase/1)

The crew's SOP is `crew/nightshift.template.yaml` and the two schemas beside
this file. The rehearsal proves the SOP produces room behavior, not prose.
Recorded: `docs/rehearsal-transcript.md` (raw post log) — and, because the
standalone deploy's Mattermost login wall gives an agent-driven browser no
secret-free path, no screen grabs this phase (see `docs/screenshots/README`).

## Setup gates

- [x] agents exist, owned by admin (`nightshift-night-lead`,
      `nightshift-worker-1`, `nightshift-worker-2`), keys chmod 600 in
      `ops/.agents/` (git-ignored); created from the template's agent blocks,
      NOT hand-grown — the provisioner reads the template.
- [x] room `overnight-crew` created from THIS document's `room:` block via
      the Gateway's `POST /rooms/from-yaml` (the Console import equivalent),
      with the template's `kickoff:` posted on behalf of the deployer by the
      server itself (room log 19:53:24 "Template kickoff on behalf of @user").
- [x] addressing rules per template: lead `anyone` (policy null), workers
      `owner-agents` (explicit rules), set through the Gateway because agent
      self-setting refuses on 0.31.0 (PROJECT_LOG phase 0, delta 3).

## The run (this session)

1. **One-line job map** — the human posts the template kickoff.
   - [x] night-lead answers in its own words, one line naming its job
         ("Hearing you loud and clear — night-lead standing by, …").
   - [x] workers stay SILENT for the human's kickoff mention (managed-stand-in
         noise aside — see transcript deltas) and for a direct mention:
         user-class messages are refused in-process ("owner-agents policy:
         user-class sender ignored").
2. **Night lead wakes the crew** — night-lead composes one agent-authored cue
   for both workers.
   - [x] worker-1 answers one line in its own words
   - [x] worker-2 answers one line in its own words
   - [x] all four reply strings distinct (checked against the transcript)
3. **The quiet rule** — human posts an anonymous `hello` (no mention).
   - [x] nobody replies (all three see `not-addressed`).

## Exit captures

- [x] transcript path: `docs/rehearsal-transcript.md`
- [x] distinct-reply check: recorded in the transcript
- [x] server-side vs runtime-side addressing note: transcript deltas

Phase-1 exit: three distinct.characters in the room log; the template's SOP
drives it; addressing demonstrably obeyed; verify green with the
phase-1 additions.
