# Phase 3 live gate rehearsal — 2026-11-05

Status: all three gate outcomes passed on the live Switch/Mattermost stack.
Task preparation for BACKLOG-2 and BACKLOG-3 was assisted, as disclosed below.
Times are UTC. Evidence follows the transcript policy in
[screenshots/README.md](screenshots/README.md); no screenshots were fabricated.

## Captured machine truth

- [Raw room posts](phase-3-room-transcript.json): original ids, timestamps,
  user ids, and messages from Mattermost; no session credentials.
- [GitHub state snapshot](phase-3-github-state.json): PR states, check results,
  merge/close timestamps, and the surviving remote branch.
- [Ledger](../supervisor/ledger.jsonl): original task entries plus gate events.
- [Taskslips](../crew/taskslips/2026-11-05.yml) and
  [gate manual](gates-manual.md).

| Task | Command post | Supervisor result | GitHub truth |
| --- | --- | --- | --- |
| B-20261104-01 | `n6t1uc9a53g7xg5aif5uf31wce` | `1ra5kjm7yib3tk96ju88n5cuao`, 11:31:50.485 | [PR #1](https://github.com/shashwat558/nightshift-target/pull/1) MERGED at 11:31:49; CI SUCCESS |
| B-20261105-02 | `uxhtzyo7qpn7jm35cqncf4t6gw` | `i8nkp5gcfin4fpue5x8rt4159y`, 11:42:57.864 | [PR #2](https://github.com/shashwat558/nightshift-target/pull/2) CLOSED; remote branch deleted |
| B-20261105-03 | `461cyjahpjditjxsmndzrs1cre` | `ebgyy9byy3rt98jeubsyxs48er`, 11:42:54.417 | [PR #3](https://github.com/shashwat558/nightshift-target/pull/3) OPEN, draft; branch retained |

The in-room manual was posted at 11:07:08.127, id
`1cjh38zfejfu3x7jmh7ozn3nxw`. The actual gate exchange:

```text
11:31:42.638 human: @shift-supervisor approve B-20261104-01
11:31:50.485 supervisor: ✅ B-20261104-01 approved — receipts clean, CI green.
Merged PR #1. Receipts filed, human signed off.

11:42:52.202 human: @shift-supervisor rollback B-20261105-02 phase-3 rehearsal: intentionally discard the tested BACKLOG-2 change to demonstrate rollback
11:42:57.864 supervisor: ♻️ rolled back: phase-3 rehearsal: intentionally discard the tested BACKLOG-2 change to demonstrate rollback
B-20261105-02: PR #2 closed · branch deleted · recorded in the ledger.

11:42:53.085 human: @shift-supervisor hold B-20261105-03 phase-3 rehearsal: leave the tested pagination PR draft for later review
11:42:54.417 supervisor: ⏸ B-20261105-03 held — the PR stays draft; nothing merges until you approve it later.
```

This excerpt removes Markdown formatting for readability. The JSON retains
exact messages, including an extra `no verdict` diagnostic preceding the
rollback success. The final implementation removes that redundant diagnostic
and returns the actual action result as its single reply.

## Assisted preparation and limits

The addressed goal at 11:30:59.737 (`88zhbna6ktyr8pn5fubts61wdr`)
reached the supervisor, which nudged night-lead at 11:31:00.130.
The lead connector replied that it was offline. A manually launched
`opencode run` then failed with `Free usage limit reached`; the configured
Z.ai coding-plan alternative returned `Insufficient balance or no resource
package. Please recharge.` No successful provider run is claimed.

Codex prepared the two slips and implemented their scoped changes directly
on separate branches from fetched `origin/main`. Each new HTTP regression
failed before its fix (8 passed, 1 failed) and passed afterwards (9 passed,
0 failed). BACKLOG-2 implements JSON 404 for missing ids, commit `72bdd8c`.
BACKLOG-3 corrects the page offset after a failing page-two test, commit
`77a2eef`. Each draft was opened using the real `createDraftPr` renderer
with raw runner output, measured minutes, and an explicit manual-assistance
statement in `deviations` and the provider label. Their task records were
appended with `appendLedger`; a supervisor restart rebuilt its gate registry.

Room post `p83brdk3zirhxmp6sfna6oschh` disclosed this before rollback/hold.
The agent executed all three typed gate commands live; no GitHub gate action
was substituted manually. These results prove live gate handling and state
changes. They do not prove a new autonomous goal-to-worker night. The N-cap,
whole-slip cancellation, block reason, and continuation paths are verified
offline, including killing a real synthetic provider process group.

## Connection findings

The earlier supervisor died about 40 seconds after opening. Frame diagnostics
showed a four-byte RFC ping. Answering it with JSON caused the server's
`keepalive ping timeout`; the fix echoes non-empty ping bytes and preserves
the cursor pong for empty pings. Protocol JSON heartbeat messages still get
their text pong. The reconnect timer was also unref'd, allowing the process
to drain after disconnect; it now keeps the process alive. Regression tests
cover binary echo and survival/reconnect in a separate Node process.

The corrected connection opened at 11:28:52, survived the former cutoff,
and was deliberately restarted as builds/ledger entries changed. The final
rehearsal connection opened at 11:42:14.778 and handled both remaining gates.
Bare goals were non-addressed on this room; explicit
`@shift-supervisor tonight: …` now parses correctly. Replayed non-addressed
goals remain ignored by design.

A separate earlier failure came from a scratch poster reusing the live
supervisor's connection id: Switch evicted the supervisor. Every client
process must use a fresh connection id. Evidence export uses read-only
Mattermost API calls, with channel discovery through the user's channel list.

## Verification

The supervisor suite passes 93/93 tests. It covers gate refusals for missing
receipt fields, FAIL tests and non-green CI; exact task ids and closed log
fences; hold/rollback; cap/deadline continuation; cancellation; merged revert
against a local bare remote; binary pongs; and reconnect process survival.
The final `./scripts/verify.sh --offline` runs this suite and the P3 decision
checks after committing, because verify requires a clean worktree. The phase
is tagged `phase/3` only after that command exits 0.
