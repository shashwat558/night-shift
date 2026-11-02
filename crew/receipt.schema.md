# Receipt schema — what a worker's PR carries so nobody speculates

A worker's PR body ends with one `receipts` block: the worker's own account
of what it did, in the supervisor's exact field order. The supervisor
(phase 3) validates a merged-candidate PR against this block before
requesting human sign-off; missing or incomplete ⇒ gate-blocked `needs-eyes`
with a room post naming exactly what is missing. A receipt that says FAIL
can never be approved.

## Format

The last non-empty block of the PR body, in markdown:

````markdown
#### receipts — B-20261103-01
- summary: one line what changed
- files-touched: comma list of paths | "none outside files_allowed"
- tests: PASS | FAIL
- test-log: RAW tail of the test runner output, in this fenced block, no paraphrase
- risk-call: low | medium | high — one sentence why
- deviations: none | bullet list of every step the slip did not authorize
- budget: <spent> / <budget> min
````

`B-20261103-01` is the task id; the block is *the same slug the taskslip
used*, so a PR can only carry one receipt (one task, one PR, one branch).

## Field rules

| Field | Required | Rule |
| --- | --- | --- |
| `summary` | yes | one line, says WHAT changed not why |
| `files-touched` | yes | comma-separated paths relative to `target/`; write `none outside files_allowed` when every path was authorized — listing them still, exactly |
| `tests` | yes | literally `PASS` or `FAIL` (the runner's exit) |
| `test-log` | yes | RAW tail of the runner output (last ~25 lines), inside the fenced block, empty fails |
| `risk-call` | yes | `low`/`medium`/`high` plus one sentence why |
| `deviations` | yes | literally `none`, or bullets declaring every unauthorized step taken (honesty, not silence) |
| `budget` | yes | `<spent> / <budget> min`, e.g. `17 / 20 min` |

## Who checks what

- **worker** fills it from its own run; a worker that cannot fit the format
  posts `receipt rejected: <why>` in the room and stops.
- **supervisor** (phase 3) re-runs nothing for the receipt itself: it checks
  fields, then its own truth — the diff against `files_allowed`, CI green,
  budget spent — before anything reaches a human gate.
- **human** sees the receipts in the PR and the room post; the gate commands
  apply to the task id on the receipts block, never to hunches.

## Parser reality (defined now, rendered from P2's prs.ts)

`supervisor/prs.ts` builds this block; `supervisor/gates.ts` (phase 3)
parses it with the same strictness. A line missing, out of order, or
paraphrased in place of RAW output ⇒ incomplete receipt ⇒ pull request stays
draft with the `needs-eyes` room post until the worker (or the human)
supplies or accepts the gap.
