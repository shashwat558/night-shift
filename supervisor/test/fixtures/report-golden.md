# Night Shift report — 2026-11-06

Merged: **1** · Rolled back: **1** · Blocked: **1** · Needs eyes: **1**

## Merged
- `A` — [PR #11](https://example.test/pull/11)

## Rolled back
- `B` — scope drift

## Blocked
- `C` — budget 10 min exceeded

## Needs eyes
- `D` — missing field: risk-call

## Worker stats
| Worker | Done | Rollbacks | Avg budget | Trust |
| --- | ---: | ---: | ---: | ---: |
| nightshift-worker-1 | 2 | 1 | 6.5 min | 50/100 |
| nightshift-worker-2 | 1 | 0 | 8.5 min | 25/100 |

Tonight's recommendation: reduce scope or increase budgets for blocked slips before adding more work.

Trust formula: merged 100; held, pending, or needs-eyes 50; rolled back, blocked, or failed tests 0; average per recorded task.
