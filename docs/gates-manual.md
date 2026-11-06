# Gate Manual — how the human commands the crew's merges

Night Shift's trust gates live in typed room commands. This is the manual
for operating them live (the short version lives in this repo; the same
grammar is pinned to the overnight-crew room).

## Why typed commands, not emoji reactions

The original plan imagined ✅/♻️/👀 reactions on the supervisor's posts as
the gate trigger. Fetched docs (2026-11-02, recorded as a docs delta in
PROJECT_LOG) showed the Switch agent protocol has **no reaction events and
no reaction ops** — Mattermost reactions exist only as the bridge's own
working/queued marks, and a human's reaction never reaches an agent. Rather
than poll Mattermost around Switch (forbidden — hard rule 7), the gates run
on typed commands. Humans may still drop the matching emoji on the
supervisor's post for the room's visuals; **the typed command is the
machine truth** and what the ledger records.

## The three commands (SPEC §4.4)

Address them to the supervisor in the room, verb-first:

```
@shift-supervisor approve <task-id>
@shift-supervisor rollback <task-id> [whatever your reason is — free text]
@shift-supervisor hold <task-id>
@shift-supervisor inspect <task-id>
```

- `<task-id>` is the exact id from the taskslip / receipts block (e.g.
  `B-20261105-01`) — the gate applies to the task id, never to hunches.
- Everything after the task id on a `rollback` is the recorded reason (it
  goes into the room post and the ledger verbatim).
- Gates run while a night is still in flight; you do not need to wait for
  the shift to finish.

## What each command does

### approve — honored ONLY with CI green at read time

Sequence the supervisor runs, in order:

1. **Receipts validation** against `crew/receipt.schema.md`. Any missing or
   incomplete field ⇒ the PR stays draft and the supervisor posts
   `needs-eyes` naming **exactly** what is missing:
   ```
   👀 needs-eyes — receipt for **B-20261105-01** is incomplete; PR stays draft:
   - missing field: risk-call
   - test-log fenced block is empty — the RAW runner tail must be inside it
   Fix the receipts block and say it again.
   ```
2. **FAIL is final**: a receipt that says `tests: FAIL` can never merge —
   refused on the spot (§4.2).
3. **CI green at read time** (`gh pr view --json statusCheckRollup`):
   pending/red/no-checks ⇒ refusal reply with the current state:
   ```
   ⛔ approve **B-20261105-01** refused — CI state: **pending** (1 checks, still running).
   approve counts only with CI green at read time (SPEC §4.4).
   ```
   Nothing is closed — say approve again once CI is green.
4. **Merge**: `gh pr ready <n>` (undraft) + `gh pr merge`. Then:
   ```
   ✅ **B-20261105-01** approved — receipts clean, CI green. Merged PR #7.
   Receipts filed, human signed off.
   ```
   Ledger: `gate_result` (approved) + `merge` events; task leaves the gate
   registry.

Every refusal is a ledger event too (`approve_refused_ci`,
`approve_refused_fail`, `needs_eyes`) — the 9 AM report counts them.

### rollback — always honored, recorded with your reason

Works on an open (draft) PR or an already-merged one:

- open PR → `gh pr close <n>` + branch deleted;
- merged PR → revert of the merge (gh pr revert, falling back to a manual
  `git revert -m 1` of the merge commit in an isolated worktree, then push
  to main). The revert PR created by gh is merged before success is reported.

Room post:
```
♻️ rolled back: worker touched auth file
B-20261105-02: PR #8 closed · branch deleted · recorded in the ledger.
```
Ledger: `gate_result` (rolled_back) with your reason text.

### hold — the PR stays draft, needs-eyes, nothing merges

```
⏸ **B-20261105-03** held — the PR stays draft; nothing merges until you approve it later.
```
Held tasks stay in the gate registry, so a later `approve` (once you're
satisfied, e.g. after the receipts were fixed in-room) or `rollback` still
works. Ledger: `gate_result` (hold).

## The budgeted night behind the gates (§3.2)

- The night processes **up to N slips sequentially** (default 5;
  `NIGHT_MAX_SLIPS` in supervisor/.env). Slips past the cap are skipped with
  an explicit 🛏 post naming the cap — they stay in the backlog.
- Each slip runs inside a wall-clock deadline of its own
  `time_budget_minutes` + a grace window (default 3 min; `NIGHT_GRACE_MS`).
- The worker process itself is killed at its budget (SIGTERM → SIGKILL on
  the process group). If the whole slip (worker + push + PR + tests) still
  exceeds its deadline, the supervisor posts:
  ```
  ⏰ `B-20261105-04` — slip deadline of 23 min (budget 20 min + grace) exceeded.
  The worker was stopped and **B-20261105-04** is blocked; the night continues with the next slip.
  ```
  and moves on — one bad night must not eat the whole backlog.

## Who says what — quick table

| You type | Place | Machine truth |
| --- | --- | --- |
| `tonight: implement BACKLOG 1-3` | room | goal → slips file → sequential night |
| `@shift-supervisor approve <id>` | room | receipts → CI → merge (or a refusal reply) |
| `@shift-supervisor rollback <id> <reason>` | room | close/revert + ledger + post |
| `@shift-supervisor hold <id>` | room | stays draft, recorded |
| `@shift-supervisor inspect <id>` | room | posts a policy/reviewer/CI/receipt card for the current commit; changes nothing |
| emoji ✅/♻️/👀 | room | visual only — never read by the supervisor |

## Ledger events the gates write

One JSON line each in `supervisor/ledger.jsonl` (machine truth; the room is
the human view): `gate_result` (with `gate: approved | rolled_back | hold |
approve_refused_ci | approve_refused_fail`), `merge`, `rollback`,
`needs_eyes`, `block`, `error`. The 9 AM report replays exactly these.

Goals can be explicitly addressed: `@shift-supervisor tonight: implement BACKLOG 2`.
Each scratch client must use its own connection id; reusing the live supervisor
connection id evicts that process.
