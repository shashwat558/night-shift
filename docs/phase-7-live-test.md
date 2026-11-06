# Phase 7 live test — trust control tower

Date: 2026-11-06

Stack: Switch 0.31.0 + Gateway + Mattermost + Postgres
Evidence: [`phase-7-room-transcript.json`](phase-7-room-transcript.json)

## Purpose

Prove that Night Shift is not merely an agent that merges green pull requests.
It binds a decision to the exact commit, applies repository-owned policy,
requires an independent receipt/diff review, and keeps the evidence visible in
the Switch room.

## Rehearsal

The pinned collaboration stack was started with both the `collab` and
`gateway` profiles. The accelerated scenario used a temporary local Git remote
and posted all control-plane messages through Switch into `overnight-crew`.
Every synthetic post was labelled `[scripted demo]`; no public pull request or
production ledger was mutated.

Three candidates exercised distinct outcomes:

1. **DEMO-01 — merge.** Tests, receipt, policy, and reviewer were clear. The
   room card bound approval to commit `464f36d722fd` and fingerprint
   `167d61ac52779064`; that exact commit merged.
2. **DEMO-02 — refuse and rollback.** Tests were green, but
   `migrations/demo.sql` matched repository policy `migrations/**`. Reviewer
   challenge and policy block appeared in the card, proving green CI is
   necessary but not sufficient.
3. **DEMO-03 — stale approval invalidated.** Its collision rebase changed the
   head from `0ba87f66` to `621f18c5`. The old approval expired, proof reran,
   and a fresh card/fingerprint (`fa68c253e56930cb`) preceded merge.

The run completed in 15.4 seconds with 2 merged and 1 rolled back. The exported
transcript contains the ordered post IDs, exact reviewed SHAs, fingerprints,
reviewer verdicts, policy outcome, and final roster report.

## Production path

The scripted run demonstrates the interaction quickly, while the production
gate uses `gh pr view` for the live GitHub head SHA, files, and status checks.
`@shift-supervisor inspect <task-id>` is read-only. `approve` recomputes the
same evidence and invokes `gh pr merge --match-head-commit <reviewed-sha>`, so
a push between review and merge is rejected by GitHub.

After the accelerated run, a human posted
`@shift-supervisor inspect B-20261105-03` through Mattermost. The live
supervisor read real GitHub PR #3 and returned commit `77a2eef54f5c`, evidence
`4a82ff369ce944a0`, actual files `src/pagination.js` and
`test/pets.test.js`, green CI, policy pass, and reviewer clear. Inspection did
not ready, merge, close, or otherwise mutate the draft PR.

## Evidence policy

No screenshot is claimed. Per [`screenshots/README.md`](screenshots/README.md),
the machine-readable room export is the authoritative evidence because the
agent browser cannot reuse Mattermost's HttpOnly human session.
