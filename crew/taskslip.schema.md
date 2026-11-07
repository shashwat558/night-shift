# Taskslip schema — the wire format the night-lead writes, the supervisor consumes

A taskslip is one work order: strictly scoped, budgeted, assigned to one
worker. The night-lead turns tonight's goal into slips and writes them to
`crew/taskslips/<date>.yml`; the supervisor parses that file,
never the chat, as the machine truth.

**File shape:** exactly one YAML document of the form below. `slips:` is the
document anchor and contains an ordered list; one night may hold 2–6 slips.

**Branch name:** `shift/<task-id>` (derives from `id`).

**Legal id:** `<backlog-ref>-<YYYYMMDD>-<NN>` — e.g. `B-20261103-01`.
Sequence NN counts from 01 per backlog-ref per date, in order of writing.

```yaml
slips:
  - id: B-20261103-01        # <backlog-ref>-<date>-<seq> ; branch is shift/<id>
    backlog_ref: BACKLOG-1   # exactly one line in target/BACKLOG.md
    title: Add input validation to POST /pets
    assignee: shift-worker-1 # one of the crew workers; supervisor rotates
    scope: >-               # what to do, in <= 3 sentences
      Validate POST /pets body: name required non-empty string,
      species optional one of cat/dog/bird. Return 400 JSON on invalid.
    files_allowed:           # hard whitelist, relative to target/
      - src/routes/pets.js
    acceptance:              # testable criteria, one line each
      - POST /pets with empty name returns 400
      - POST /pets with species fish returns 400
      - existing tests still pass
      - new tests cover both failures
    time_budget_minutes: 20  # wall clock from worker start; supervisor enforces
    notes: >-               # OPTIONAL. why this matters, gotchas
      BACKLOG-2 fixes this same file — expect a claim round if it goes
      out of order.
```

## Field rules

| Field | Required | Rule |
| --- | --- | --- |
| `id` | yes | legal id; unique per night; base of the branch name |
| `backlog_ref` | yes | `BACKLOG-<n>`; a line in `target/BACKLOG.md`; `<n>` unique |
| `title` | yes | one line, imperative voice |
| `assignee` | yes | `shift-worker-1` or `shift-worker-2` (rotation by round-robin) |
| `scope` | yes | ≤ 3 sentences; says what to do, not how |
| `files_allowed` | yes (may be `[]`) | hard whitelist; relative paths inside `target/`; never leaves `target/` |
| `acceptance` | yes, 1–5 items | every line independently testable by running the test suite |
| `time_budget_minutes` | yes, int 5–45 | wall clock; worker is stopped when exceeded |
| `notes` | no | free text for the worker |

## What the supervisor does with a slip

- validates the fields above; a row failing validation gets no worker and the
  night-lead gets `@nightshift-night-lead taskslip <id>: <what is missing>`.
- spawns the worker on branch `shift/<id>`, feeds the slip verbatim.
- treats any path outside `files_allowed` in the worker diff as a rollback
  trigger (P3), and the receipt's `deviations` block is where honest workers
  declare drift (never punishment — but always recorded).

## Parser reality (defined now, implemented in P2)

The supervisor parses this file with a tiny strict YAML subset:
document `slips:` + list items + two-space indent, keys above, inline or
`>-` scalars, and nothing beyond. Anything the tiny parser cannot hold
does not parse ⇒ the whole file is rejected and re-asked from night-lead.
