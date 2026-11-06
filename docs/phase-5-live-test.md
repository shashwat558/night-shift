# Phase 5 live report rehearsal — 2026-11-06

Status: the Phase 5 build produced and posted the correct ledger-only shift
report on the live Switch stack. Times below are UTC. The credential-free
room transcript is the evidence.

- [Raw room transcript](phase-5-room-transcript.json): the human trigger and
  supervisor report, with original post IDs, timestamps, and sender IDs.
- [Ledger](../supervisor/ledger.jsonl): the append-only source events and the
  final `report_posted` event.
- Runtime artifact: `docs/reports/2026-11-06.md` (intentionally git-ignored;
  its exact posted content is preserved in the raw transcript).

All four services were running for the rehearsal: Switch on `:8000`, Gateway
on `:3100`, Mattermost on `:8065`, and Postgres on `:5432`; both health-checked
containers were healthy. The freshly built supervisor connected, restored
its ledger registry, and scheduled the next report for local 09:00.

At 19:07:38 the human posted
`@shift-supervisor shift report please`. The supervisor replied 508 ms later
with a report derived from the 20 ledger events since the previous report:
3 merged PRs with links, 1 rollback with its reason, 0 blocked, 0 needs-eyes,
and a recommendation to review rollback causes. The ledger then appended:

```json
{"ts":"2026-11-05T19:07:38.916Z","actor":"shift-supervisor","type":"report_posted","refs":{"file":"docs/reports/2026-11-06.md","trigger":"room","events":20}}
```

Running `supervisor report` immediately afterwards returned
`reused docs/reports/2026-11-06.md`; it neither posted again nor appended a
second event. The accelerated clock test fires its first run at 25 ms and
then arms the normal daily clock. The deterministic fixture test renders an
exact golden Markdown file, while the Phase 5 verifier repeats that replay
from a scratch git clone.

The five historical task entries predate worker attribution in the ledger,
so the honest live report groups them as `unassigned`. New task entries now
persist the slip assignee in `worker`, and the golden fixture demonstrates
per-worker done, rollback, average-budget, and trust rows. No identity is
inferred from mutable room history during replay.
