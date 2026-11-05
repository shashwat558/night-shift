# Phase 4 live collision rehearsal — 2026-11-05/06

Status: both curated PRs landed in the agreed order on the live Switch stack.
Times below are UTC. The room transcript uses the repository's transcript
policy in `docs/screenshots/README.md`.

- [Raw room transcript](phase-4-room-transcript.json): original post IDs,
  timestamps, sender IDs, and messages, without session credentials.
- [GitHub state](phase-4-github-state.json): merged PRs #4/#5, CI checks, and
  the resulting main commit.
- [Ledger](../supervisor/ledger.jsonl): the diff collision, agreed order,
  gate approvals, merges, and receipt correction events.
- [Taskslips](../crew/taskslips/2026-11-05.yml): BACKLOG-5/6 scopes and budgets.

The actual branch diffs shared `src/app.js`; the other changed files did not
overlap. The supervisor posted a `file-collision on src/app.js` prompt. Two
worker bot identities posted one claim each: BACKLOG-5 should land first,
BACKLOG-6 should rebase after it. The supervisor checked the claims against
the diff and posted `B-20261105-04 → B-20261105-05`, recording
`negotiation_result` in the ledger.

PR [#4](https://github.com/shashwat558/nightshift-target/pull/4) passed its
real test suite and green CI, then merged first through the supervisor's
addressed approve gate at 15:08:54 UTC. Rebasing PR
[#5](https://github.com/shashwat558/nightshift-target/pull/5) onto the new
main caused the expected `src/app.js` conflict. The resolution kept both
route imports and mounts. The combined target suite passed 10/10 tests; the
branch was force-pushed with lease and CI completed SUCCESS. PR #5's receipt
was rebuilt from the raw new test output and updated through GitHub REST
because `gh pr edit` failed on the deprecated Projects Classic GraphQL field.
The second addressed approve gate merged #5 at 18:36:58 UTC. `origin/main`
contains both `/stats` and `/version` routes.

The configured worker providers remained unavailable. Codex manually wrote
the scoped code and taskslips. The two worker claims were scripted through
their own Switch bot identities. Room post `fsktonhtrbfjjxgj4dsgaf8hrw`
disclosed that before negotiation, and both PR receipts disclose manual
assistance. This proves the live scanner, claim decision, gate ordering,
rebase, retest, and resulting product state. It does not claim autonomous
worker reasoning or autonomous conflict resolution.

Two early `receipt_ok` ledger events were written by interrupted attempts
before the PR body update succeeded. A later `error` event marks them
unverified; a `receipt_ok` event with `validated: true` records the confirmed
GitHub body. The final ordered gate rule requires that validated marker,
first merge, and a second branch based on current `origin/main`. This rule
was added after the rehearsal; its refusal path is covered by offline tests.
