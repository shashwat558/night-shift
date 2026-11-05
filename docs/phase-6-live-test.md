# Phase 6 accelerated demo rehearsal — 2026-11-06

Status: the complete scripted judge night ran through the live Switch room in
5.8 seconds, below the ten-minute budget. Every room message is explicitly
prefixed `[scripted demo]`. Evidence follows `docs/screenshots/README.md`.

- [Raw room transcript](phase-6-room-transcript.json): ten credential-free
  Mattermost posts with original IDs, timestamps, sender ID, and content.
- [Script](../demo/run.mjs) and [night](../demo/night.yml): the executable
  deterministic scenario and its three-slip contract.

The runner created an isolated temporary Git remote from the current target
main. It created and tested three candidate branches with the real petshop
suite, rendered and validated production-format receipts, and checked the
production gate decision table with green deterministic CI. `DEMO-01` and
`DEMO-03` both added `demo/shared.txt`; the production collision scanner found
that actual overlap. Two valid claims agreed on `DEMO-01 -> DEMO-03`.

The runner merged `DEMO-01`, deleted the rollback branch for `DEMO-02` with
the recorded reason, then attempted to rebase `DEMO-03`. Git produced the
intended add/add conflict. The deterministic resolution retained both lines,
the target tests passed again, and `DEMO-03` merged into the temporary main.
The final in-memory append-only ledger replay reported two merges, one
rollback, zero blocked, zero needs-eyes, and per-worker trust statistics.

This rehearsal does not create public GitHub PRs and does not claim autonomous
worker reasoning. The displayed PR numbers are demo identifiers. Its purpose
is a fast, repeatable execution of the same branch, receipt, gate, collision,
retest, and report machinery without spending provider credits or mutating the
production target checkout and ledger. The Phase 3–5 evidence documents remain
the proof of real GitHub PRs, human gates, ordered landing, and the live report.
